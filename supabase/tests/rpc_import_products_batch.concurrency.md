# Teste manual de concorrência — `rpc_import_products_batch`

Um único script SQL é sequencial por natureza — não produz concorrência real.
Os dois procedimentos abaixo usam **dois terminais `psql` separados** contra o
mesmo banco de **teste** (nunca produção) para observar o comportamento real
sob corrida. Ambos usam `pg_sleep` dentro de uma cópia local, com fins de
teste, das funções para criar uma janela de tempo observável — sem alterar as
funções de produção.

Pré-requisitos: migration `202607302400_rpc_import_products_batch.sql`
aplicada; um usuário real com `role IN ('admin','gerente')` e `company_id=1`
ativo (mesmo usado em `rpc_import_products_batch.test.sql`).

## 1. Corrida de `idempotency_key`

Objetivo: confirmar que duas chamadas concorrentes com a mesma
`(company_id, idempotency_key)` nunca criam dois lotes — uma delas deve
esperar a outra e devolver o mesmo resultado (ou processar do zero, se a
primeira falhou).

**Terminal A:**
```sql
BEGIN;
SELECT id INTO TEMP TABLE _t_user FROM public.users WHERE company_id=1 AND role IN ('admin','gerente') AND active=true LIMIT 1;

-- Insere a reserva e força uma pausa ANTES de completar o resto da função,
-- simulando processamento lento — abra o Terminal B durante o pg_sleep.
SELECT pg_sleep(0), public.rpc_import_products_batch(
  1,
  (SELECT id FROM _t_user),
  jsonb_build_array(jsonb_build_object(
    'client_index', 0, 'name', 'Concorrencia A', 'tipo', 'x', 'modelo', 'y', 'ano', '2026',
    'category_id', (SELECT id FROM public.categories WHERE company_id=1 LIMIT 1),
    'supplier_id', NULL, 'brand_id', NULL, 'origin', 'third_party',
    'base_cost', 10, 'base_price', 20, 'active', true,
    'sku', '8888880001', 'sku_scheme', 'legacy',
    'modelo_variation_type_id', NULL, 'modelo_value_id', NULL, 'variants', jsonb_build_array()
  )),
  'concorrencia-idempotencia-manual'
);
-- NÃO dê COMMIT ainda — deixe a transação aberta e vá para o Terminal B.
```

**Terminal B (enquanto A ainda não deu COMMIT):**
```sql
BEGIN;
SELECT public.rpc_import_products_batch(
  1,
  (SELECT id FROM public.users WHERE company_id=1 AND role IN ('admin','gerente') AND active=true LIMIT 1),
  jsonb_build_array(jsonb_build_object(
    'client_index', 0, 'name', 'Concorrencia B', 'tipo', 'x', 'modelo', 'y', 'ano', '2026',
    'category_id', (SELECT id FROM public.categories WHERE company_id=1 LIMIT 1),
    'supplier_id', NULL, 'brand_id', NULL, 'origin', 'third_party',
    'base_cost', 10, 'base_price', 20, 'active', true,
    'sku', '8888880002', 'sku_scheme', 'legacy',
    'modelo_variation_type_id', NULL, 'modelo_value_id', NULL, 'variants', jsonb_build_array()
  )),
  'concorrencia-idempotencia-manual'  -- MESMA chave de A
);
```
**Resultado esperado:** o comando em B **bloqueia** (fica pendurado, sem
retornar) — a `INSERT INTO import_batches` de B está esperando a linha
inserida (não commitada) por A liberar o lock da constraint única.

**Terminal A — agora dê COMMIT:**
```sql
COMMIT;
```
**Resultado esperado em B:** desbloqueia imediatamente e retorna o **mesmo
resultado JSON produzido por A** (o produto "Concorrencia A", não um novo
"Concorrencia B") — confirma que B nunca processou nada, só devolveu o
resultado já commitado por A.

**Terminal B — finalize:**
```sql
ROLLBACK;  -- B não escreveu nada de qualquer forma, mas fecha a transação
```

**Variante (A falha em vez de commitar):** repita o procedimento, mas em vez
de `COMMIT` no Terminal A, dê `ROLLBACK`. Resultado esperado: o Terminal B
desbloqueia e processa o payload de B do zero (a chave ficou livre porque a
reserva de A foi desfeita junto com o resto da transação de A).

---

## 2. Corrida de `sku_base`

Objetivo: confirmar que duas transações concorrentes tentando alocar
`sku_variation` a partir da MESMA base não conseguem persistir o mesmo SKU —
com o `pg_advisory_xact_lock` adicionado nesta auditoria, a segunda espera a
primeira terminar e recebe automaticamente o sufixo seguinte (`+02`), em vez
de abortar por `unique_violation`.

**Terminal A:**
```sql
BEGIN;
SELECT pg_advisory_xact_lock(hashtextextended('8888889000', 0));
-- Segure o lock manualmente aqui pra simular o processamento de A — vá
-- para o Terminal B agora, SEM COMMIT/ROLLBACK ainda neste terminal.
```

**Terminal B (enquanto A ainda segura o lock):**
```sql
BEGIN;
SELECT public._resolve_unique_sku_variation('8888889000');
-- Deve FICAR PENDURADO aqui — B está esperando o advisory lock que A
-- segura, em vez de checar "livre" e colidir com A no INSERT final.
```

**Terminal A — libere o lock:**
```sql
ROLLBACK;  -- pg_advisory_xact_lock libera automaticamente ao fim da transação
```

**Resultado esperado em B:** desbloqueia imediatamente e retorna
`'8888889000'` (a base, já que ninguém mais a usou de fato — A só segurou o
lock, não inseriu nada em `product_variations`).
```sql
ROLLBACK;  -- finalize o Terminal B
```

**Variante mais próxima do uso real** (duas chamadas completas da RPC com o
mesmo `sku_base` de fato inserindo variação): repita o procedimento do item 1
acima, mas com dois produtos usando o mesmo `sku_base` no `variants` em vez
da mesma `idempotency_key` — o comportamento esperado é: A insere
`sku_variation = base`; B (que só processa depois que A libera o lock via
commit) recebe `sku_variation = base + '02'` — nunca o mesmo SKU duas vezes,
e nenhuma das duas transações aborta por `unique_violation` (o que
aconteceria sem o `pg_advisory_xact_lock`, documentado no cabeçalho da
migration como comportamento alternativo caso o lock não fosse implementado).

---

## Conclusão a registrar após rodar

Depois de executar os dois procedimentos, anote no PR/changelog:
- [ ] Idempotência: B esperou e devolveu o resultado de A (não duplicou).
- [ ] Idempotência (variante falha): B processou do zero quando A deu rollback.
- [ ] SKU: B esperou o lock de A e recebeu sufixo diferente, sem `unique_violation`.
