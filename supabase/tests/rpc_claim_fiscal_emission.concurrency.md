# Teste manual de concorrência — `rpc_claim_fiscal_emission` / `rpc_complete_fiscal_emission` / `rpc_begin_fiscal_transmission`

Um único script SQL é sequencial por natureza — não produz concorrência
real. O procedimento abaixo usa **dois terminais `psql` separados** contra
o mesmo banco de **teste** (nunca produção) pra observar o claim/lease da
Fase Fiscal 3B (incluindo o fechamento do risco residual #2 —
`submission_started_at`/`rpc_begin_fiscal_transmission`) funcionando de
verdade sob concorrência real de Postgres — os testes automatizados
(`submitNfeHomologacao.concurrency.test.ts`) só provam que o *service*
reage corretamente a cada decisão possível, contra uma simulação em
memória de thread única (Node/JS); só este procedimento prova que o
`FOR UPDATE` (bloqueante, não `SKIP LOCKED` — aqui queremos que a segunda
transação ESPERE a primeira, não pule pra outra linha, diferente do padrão
usado em `rpc_claim_outbox_events`) serializa corretamente duas conexões
reais.

Pré-requisito: migration `20260826_fiscal_emission_claim.sql` aplicada
(já inclui `submission_started_at` e `rpc_begin_fiscal_transmission` —
não é uma migration separada).

## 1. Fixture — 1 empresa, 1 cliente, 1 venda de teste

Rode uma vez, em qualquer terminal (fora de transação, comita direto):

```sql
DO $$
DECLARE
  v_company  int;
  v_customer int;
  v_seller   uuid;
  v_sale     int;
BEGIN
  INSERT INTO public.companies (name, slug, plan, active)
  VALUES ('TESTE Claim Fiscal — APAGAR', 'teste-claim-fiscal-apagar', 'starter', true)
  RETURNING id INTO v_company;

  INSERT INTO public.customers (name, cpf, phone, company_id, active)
  VALUES ('Cliente Teste Claim — APAGAR', '99988877701', '84999990001', v_company, true)
  RETURNING id INTO v_customer;

  SELECT id INTO v_seller FROM auth.users LIMIT 1;

  INSERT INTO public.sales (customer_id, seller_id, company_id, status, payment_method, sale_date, total)
  VALUES (v_customer, v_seller, v_company, 'paid', 'pix', CURRENT_DATE, 100)
  RETURNING id INTO v_sale;

  CREATE TEMP TABLE IF NOT EXISTS claim_test_fixture (company_id int, sale_id int);
  DELETE FROM claim_test_fixture;
  INSERT INTO claim_test_fixture VALUES (v_company, v_sale);

  RAISE NOTICE 'Fixture: company=%, sale=%', v_company, v_sale;
END $$;

SELECT * FROM claim_test_fixture;
-- Anote company_id e sale_id — precisa deles nos dois terminais abaixo.
-- `claim_test_fixture` é TEMP — só existe nesta sessão; anote os valores
-- reais pra colar nos comandos dos dois terminais (sessões diferentes não
-- compartilham TEMP TABLE).
```

## 2. Corrida de claim — exatamente 1 "claimed", o outro "busy"

Substitua `<company_id>`/`<sale_id>` pelos valores anotados acima em
AMBOS os terminais.

**Terminal A:**
```sql
BEGIN;
SELECT decision, id, submission_claim_token, submission_lease_until, submission_started_at
FROM public.rpc_claim_fiscal_emission(<company_id>, <sale_id>, 'qarvon-<company_id>-<sale_id>-nfe', 'homologacao', 60);
-- Esperado: decision='claimed', submission_claim_token preenchido,
-- submission_started_at NULL (nenhuma transmissão despachada ainda —
-- só rpc_begin_fiscal_transmission, chamado pelo service ANTES do POST,
-- marcaria isso).
-- NÃO dê COMMIT/ROLLBACK ainda — a linha continua travada (FOR UPDATE
-- dentro da função) enquanto esta transação estiver aberta. Vá para o
-- Terminal B agora.
```

**Terminal B (enquanto A ainda não deu COMMIT/ROLLBACK):**
```sql
BEGIN;
SELECT decision, id, submission_claim_token, submission_lease_until, submission_started_at
FROM public.rpc_claim_fiscal_emission(<company_id>, <sale_id>, 'qarvon-<company_id>-<sale_id>-nfe', 'homologacao', 60);
```

**Resultado esperado em B:** o comando **FICA PENDURADO** (bloqueado) —
diferente do padrão `SKIP LOCKED` da `rpc_claim_outbox_events`, aqui B
precisa ESPERAR A terminar, porque estamos reivindicando o MESMO
documento, não escolhendo outro da fila. Isso já é a prova de que o
`FOR UPDATE` está serializando corretamente — se B retornasse na hora com
`decision='claimed'` também, seria uma falha grave (duas transmissões
concorrentes possíveis).

**Terminal A — libere o lock:**
```sql
COMMIT;
```

**Terminal B — agora deve retornar imediatamente:**
Esperado: `decision='busy'`, com o MESMO `submission_claim_token` que A
recebeu (prova que B enxergou o estado que A gravou, não criou nada
novo).
```sql
COMMIT;
```

## 3. Corrida de conclusão — worker antigo nunca sobrescreve o vigente

Continuando da fixture acima (a linha já tem o `submission_claim_token`
de A). Anote o `id` do documento retornado no passo 2 como `<doc_id>` e o
token de A como `<token_a>`.

**Terminal A — expira a lease manualmente (simula o processo travando/crashando) e deixa outro claim acontecer:**
```sql
UPDATE public.fiscal_documents SET submission_lease_until = NOW() - interval '1 second' WHERE id = <doc_id>;
-- Repare: NÃO precisamos mais forçar status='submission_error' aqui como
-- em versões anteriores deste roteiro. A linha de A nunca chegou a chamar
-- rpc_begin_fiscal_transmission (nesta simulação só chamamos o claim, não
-- o service inteiro) — submission_started_at continua NULL. Sem
-- evidência de transmissão despachada, expirar a lease sozinha já é
-- suficiente pra liberar um claim novo, mesmo com status ainda 'pending'
-- (ver seção 4 do roteiro abaixo pro caso OPOSTO — quando
-- submission_started_at ESTÁ setado, isto sozinho NÃO seria suficiente).

SELECT decision, submission_claim_token, submission_started_at FROM public.rpc_claim_fiscal_emission(<company_id>, <sale_id>, 'qarvon-<company_id>-<sale_id>-nfe', 'homologacao', 60);
-- Esperado: decision='claimed', um token NOVO e DIFERENTE de <token_a>,
-- submission_started_at NULL (resetado pelo claim, ver rpc_claim_fiscal_emission).
-- Anote o token como <token_b>.
```

**Terminal A (mesma sessão) — B "conclui" primeiro:**
```sql
SELECT status, access_key FROM public.rpc_complete_fiscal_emission(<doc_id>, '<token_b>', 'authorized', NULL, NULL, NULL, NULL, NULL, NULL, 'chave-worker-b-teste');
-- Esperado: 1 linha, status='authorized', access_key='chave-worker-b-teste'.
```

**Terminal A (mesma sessão) — worker "antigo" (token de A) tenta concluir DEPOIS:**
```sql
SELECT * FROM public.rpc_complete_fiscal_emission(<doc_id>, '<token_a>', 'submission_error', NULL, 'resultado do worker antigo, nunca deveria vencer');
-- Esperado: ZERO linhas — o UPDATE não afeta nada porque submission_claim_token
-- já não é mais <token_a>.

SELECT status, access_key FROM public.fiscal_documents WHERE id = <doc_id>;
-- Esperado: status='authorized', access_key='chave-worker-b-teste' — o
-- resultado do worker "antigo" NUNCA sobrescreveu o do worker vigente.
```

## 4. Risco residual #2 — `submission_started_at` bloqueia reclamar mesmo com lease expirada

Este é o cenário central do fechamento do risco residual #2: uma
transmissão HTTP real foi despachada (`rpc_begin_fiscal_transmission`
rodou) e a lease expira ANTES do resultado ser conhecido — diferente da
seção 3 acima (onde nenhuma transmissão jamais foi despachada), aqui a
lease expirar sozinha NUNCA deve liberar um `claimed` direto.

Rode uma nova fixture (repita o passo 1) ou reutilize `<company_id>`/
`<sale_id>` de uma venda nova, pra começar de uma linha limpa.

**Terminal único (sequencial é suficiente aqui — o ponto é o estado gravado, não a corrida em si):**
```sql
-- 1. Claim normal.
SELECT decision, id, submission_claim_token
FROM public.rpc_claim_fiscal_emission(<company_id>, <sale_id>, 'qarvon-<company_id>-<sale_id>-nfe', 'homologacao', 60);
-- Anote <doc_id> e <token_c>. Esperado: decision='claimed'.

-- 2. Simula o service chamando rpc_begin_fiscal_transmission IMEDIATAMENTE
-- ANTES do POST /v2/nfe (exatamente como submitNfeHomologacao.ts faz).
SELECT submission_started_at FROM public.rpc_begin_fiscal_transmission(<doc_id>, '<token_c>');
-- Esperado: 1 linha, submission_started_at preenchido (agora).

-- 3. Simula o POST demorando mais que a lease (ou o processo morrendo
-- logo depois de despachar): expira a lease manualmente, SEM tocar
-- submission_started_at nem status (que continua 'pending').
UPDATE public.fiscal_documents SET submission_lease_until = NOW() - interval '1 second' WHERE id = <doc_id>;

-- 4. Uma nova execução tenta reclamar o mesmo documento.
SELECT decision, submission_claim_token FROM public.rpc_claim_fiscal_emission(<company_id>, <sale_id>, 'qarvon-<company_id>-<sale_id>-nfe', 'homologacao', 60);
-- ESPERADO CRÍTICO: decision='reconciliation_required', com o MESMO
-- submission_claim_token de <token_c> (a linha NÃO foi alterada — nenhum
-- claim novo foi concedido). Se isto retornasse 'claimed' aqui, seria
-- exatamente o risco residual #2 reaberto: duas transmissões HTTP
-- concorrentes possíveis com a mesma provider_ref.

-- 5. Simula a reconciliação (consulta à Focus) confirmando ausência
-- inequívoca — só isso libera reclamar de novo, e só com a MESMA provider_ref.
SELECT submission_started_at, status FROM public.rpc_complete_fiscal_emission(<doc_id>, '<token_c>', 'submission_error', NULL, 'Focus confirmou que esta referência nunca foi recebida.');
-- Esperado: submission_started_at agora NULL (limpo porque p_status <> 'pending'
-- — ver comentário de rpc_complete_fiscal_emission na migration).

-- 6. SÓ AGORA um claim novo é concedido.
SELECT decision, submission_claim_token FROM public.rpc_claim_fiscal_emission(<company_id>, <sale_id>, 'qarvon-<company_id>-<sale_id>-nfe', 'homologacao', 60);
-- Esperado: decision='claimed', token NOVO e DIFERENTE de <token_c>.
```

## 5. `rpc_begin_fiscal_transmission` com lease vencida — race condition REAL encontrada e fechada

Achado em Postgres real (não neste roteiro — em teste manual anterior):
`submission_lease_until = 02:40:01`, `rpc_begin_fiscal_transmission` executou
com sucesso às `02:40:21` — 20s DEPOIS da lease vencer. O guard antigo só
checava `id` + `submission_claim_token`, nunca a lease nem
`submission_started_at`. Corrigido: agora exige também
`submission_lease_until > NOW()` e `submission_started_at IS NULL`.

Rode uma fixture nova (repita a seção 1) ou reutilize `<company_id>`/
`<sale_id>` de uma venda nova, pra começar de uma linha limpa.

### 5.1 Reprodução exata do bug (sequencial, 1 terminal — prova que FECHOU)

```sql
-- Claim normal.
SELECT decision, id, submission_claim_token
FROM public.rpc_claim_fiscal_emission(<company_id>, <sale_id>, 'qarvon-<company_id>-<sale_id>-nfe', 'homologacao', 60);
-- Anote <doc_id> e <token_d>.

-- begin com lease AINDA ativa → sucesso (teste 1 do pedido).
SELECT id, submission_started_at
FROM public.rpc_begin_fiscal_transmission(<doc_id>, '<token_d>', '{"smoke":true}'::jsonb, '{"smoke":true}'::jsonb);
-- Esperado: 1 linha, submission_started_at preenchido.

-- segundo begin com o MESMO claim (já iniciado) → zero linhas (teste 3 do pedido).
SELECT id FROM public.rpc_begin_fiscal_transmission(<doc_id>, '<token_d>', NULL, NULL);
-- Esperado: ZERO linhas — submission_started_at já não é NULL.
```

Repita com uma fixture NOVA pra testar lease vencida isoladamente (sem
already-started interferir):

```sql
SELECT decision, id, submission_claim_token
FROM public.rpc_claim_fiscal_emission(<company_id>, <sale_id2>, 'qarvon-<company_id>-<sale_id2>-nfe', 'homologacao', 60);
-- Anote <doc_id2> e <token_e>.

-- Simula o worker demorando mais que a lease ANTES de chamar begin —
-- exatamente o cenário do bug real (nada mais reclamou a linha).
UPDATE public.fiscal_documents SET submission_lease_until = NOW() - interval '1 second' WHERE id = <doc_id2>;

-- begin com lease JÁ VENCIDA, MESMO claim_token → ANTES da correção isto
-- tinha sucesso (era o bug). Esperado AGORA: ZERO linhas (teste 2 do pedido).
SELECT id FROM public.rpc_begin_fiscal_transmission(<doc_id2>, '<token_e>', NULL, NULL);

SELECT submission_started_at FROM public.fiscal_documents WHERE id = <doc_id2>;
-- Esperado: NULL — o begin recusado nunca gravou nada.
```

### 5.2 Corrida real: worker antigo (lease vencida) vs. claim novo — 2 terminais

Continuando do `<doc_id2>`/`<token_e>` acima (lease já vencida, `submission_started_at` ainda NULL).

**Terminal A — reclama de novo (claim novo, token novo) e SEGURA a transação aberta:**
```sql
BEGIN;
SELECT decision, submission_claim_token
FROM public.rpc_claim_fiscal_emission(<company_id>, <sale_id2>, 'qarvon-<company_id>-<sale_id2>-nfe', 'homologacao', 60);
-- Esperado: decision='claimed', token NOVO e DIFERENTE de <token_e>. Anote <token_f>.
-- NÃO dê COMMIT ainda — a linha continua travada (FOR UPDATE dentro da
-- função). Vá para o Terminal B agora.
```

**Terminal B (enquanto A ainda não deu COMMIT) — worker "antigo" tenta begin com `<token_e>`:**
```sql
SELECT id FROM public.rpc_begin_fiscal_transmission(<doc_id2>, '<token_e>', NULL, NULL);
```

**Resultado esperado em B:** o comando **FICA PENDURADO** (bloqueado) — B
precisa esperar A liberar o lock da linha (mesmo padrão de serialização da
seção 2). Isso já é evidência de que não existe brecha de MVCC aqui — as
duas operações disputam a MESMA linha, nunca correm de fato em paralelo.

**Terminal A — libere o lock:**
```sql
COMMIT;
```

**Terminal B — agora deve retornar imediatamente:**
Esperado: **ZERO linhas** — quando B finalmente adquire o lock e reavalia
seu `WHERE`, `submission_claim_token` já não é mais `<token_e>` (A já
trocou pra `<token_f>` e commitou) — recusado por token, nem chega a
precisar da checagem de lease pra este caso especificamente (prova que a
exclusividade de token, sozinha, já impedia dois `POST` reais nos fluxos
automatizados — a lease fecha a lacuna semântica/operacional, não uma
lacuna de dois `POST` concorrentes via este caminho).

```sql
-- Prova que o token novo (F) consegue begin normalmente (teste 4/5 do pedido).
SELECT id, submission_started_at
FROM public.rpc_begin_fiscal_transmission(<doc_id2>, '<token_f>', NULL, NULL);
-- Esperado: 1 linha, submission_started_at preenchido.
```

### 5.3 `rpc_complete_fiscal_emission` continua funcionando mesmo com lease vencida pós-begin (teste 7 do pedido — NÃO alterada nesta revisão)

```sql
UPDATE public.fiscal_documents SET submission_lease_until = NOW() - interval '1 second' WHERE id = <doc_id2>;

SELECT status, access_key FROM public.rpc_complete_fiscal_emission(<doc_id2>, '<token_f>', 'authorized', NULL, NULL, NULL, NULL, NULL, NULL, '11111111111111111111111111111111111111111111');
-- Esperado: 1 linha, status='authorized' — complete NUNCA checou lease,
-- continua exatamente assim.
```

## 6. Limpeza

```sql
DELETE FROM public.fiscal_documents WHERE sale_id IN (SELECT sale_id FROM claim_test_fixture);
DELETE FROM public.sales WHERE id IN (SELECT sale_id FROM claim_test_fixture);
DELETE FROM public.customers WHERE company_id IN (SELECT company_id FROM claim_test_fixture);
DELETE FROM public.companies WHERE id IN (SELECT company_id FROM claim_test_fixture);
DROP TABLE IF EXISTS claim_test_fixture;
```

## Conclusão a registrar após rodar

- [ ] Seção 2: B bloqueou (não retornou na hora) enquanto A tinha a transação aberta.
- [ ] Seção 2: depois do `COMMIT` de A, B recebeu `decision='busy'` com o MESMO token de A.
- [ ] Seção 3: B recebeu um `claim_token` diferente do de A depois da lease expirar (sem `submission_started_at`, sem precisar forçar status).
- [ ] Seção 3: a conclusão do worker "antigo" (token de A) foi recusada (zero linhas afetadas) e NÃO sobrescreveu o resultado do worker vigente.
- [ ] Seção 4 (risco residual #2): depois de `rpc_begin_fiscal_transmission`, expirar a lease sozinha NÃO liberou um `claimed` — o claim seguinte recebeu `reconciliation_required` com o MESMO `submission_claim_token` de <token_c>.
- [ ] Seção 4: só depois de `rpc_complete_fiscal_emission` limpar `submission_started_at` (status ≠ 'pending') um claim novo foi concedido — e sempre com a MESMA `provider_ref`.
- [ ] Seção 5.1: begin com lease ativa teve sucesso; segundo begin com o mesmo claim (já iniciado) devolveu zero linhas; begin com lease vencida (mesmo token, sem ninguém reclamar) devolveu zero linhas — reproduz e fecha o bug real (`02:40:01`/`02:40:21`).
- [ ] Seção 5.2: Terminal B bloqueou enquanto Terminal A tinha a transação de claim aberta; depois do `COMMIT` de A, o begin do token antigo (`<token_e>`) devolveu zero linhas; o begin do token novo (`<token_f>`) teve sucesso.
- [ ] Seção 5.3: `rpc_complete_fiscal_emission` continuou funcionando com a lease já vencida — confirma que ela não foi (e não precisa ser) alterada.
