# Fase Fiscal 3B — Lock/idempotência de concorrência da emissão NF-e

## A. Risco anterior (real, confirmado por leitura de código)

Em `submitNfeHomologacao.ts` (versão anterior a esta fase), `getOrCreateFiscalDocument` buscava/criava a linha de `fiscal_documents` e retornava. O `submitNfeHomologacao` então checava `status` (authorized/cancelled/pending) e, se nenhum desses, seguia para carregar contexto, validar, montar payload e chamar `issueFocusNfe` — **sem nenhum lock entre a checagem de status e o `POST /v2/nfe`**.

Duas chamadas concorrentes para a mesma venda nova: ambas chamavam `getOrCreateFiscalDocument` — uma vencia o `INSERT`, a outra perdia (23505) e re-buscava a MESMA linha (ainda `draft`). **Ambas** passavam pelas checagens de status (nenhuma era `authorized`/`cancelled`/`pending` ainda) e **ambas** prosseguiam, independentemente, até `issueFocusNfe` — duas chamadas HTTP concorrentes com a mesma `ref` à Focus. O único freio era o `UNIQUE(provider, provider_ref)`, que protege o `INSERT` da linha, nunca duas transmissões concorrentes sobre uma linha já existente.

## B. Arquitetura implementada

`rpc_claim_fiscal_emission` (claim atômico curto, `SELECT ... FOR UPDATE` só dentro da própria função) decide entre `claimed`/`busy`/`already_authorized`/`already_cancelled`/`reconciliation_required` **antes** de qualquer HTTP. Só `claimed` (com `claim_token` imprevisível de `gen_random_uuid()` e lease de 60s) autoriza prosseguir. Toda escrita de resultado depois do claim passa por `rpc_complete_fiscal_emission`, que só afeta a linha se `submission_claim_token` ainda for o mesmo — zero linhas afetadas = "meu resultado foi superado, não sobrescrevo nada" (nunca um erro).

A lease é **sempre liberada** (`submission_lease_until = NULL`) ao concluir, não importa o status — inclusive quando o resultado ainda é `pending` (timeout/rede). Isso é o que faz "lease expirou ≠ POST novamente" funcionar: um documento `pending` sem lease ativa sempre cai em `reconciliation_required` (nunca em `claimed` direto), forçando consulta à Focus antes de qualquer nova tentativa.

`claim_token`/`claimed_at` nunca são apagados — ficam como registro histórico (observabilidade).

## C. Migration — exatamente o que mudou

`supabase/migrations/20260826_fiscal_emission_claim.sql`:
- `fiscal_documents` ganha 4 colunas: `submission_claim_token TEXT`, `submission_claimed_at TIMESTAMPTZ`, `submission_lease_until TIMESTAMPTZ`, `submission_attempts INT NOT NULL DEFAULT 0`.
- 2 funções novas: `rpc_claim_fiscal_emission(p_company_id, p_sale_id, p_provider_ref, p_environment, p_lease_seconds=60)` e `rpc_complete_fiscal_emission(p_fiscal_document_id, p_claim_token, p_status, ...)`.
- `UNIQUE(provider, provider_ref)`, `UNIQUE(access_key) WHERE NOT NULL`, `UNIQUE(sale_id, document_type) WHERE status='authorized'` — **intocadas**.

## D. Fluxo

```
Primeira emissão:      claim → 'claimed' → valida → monta payload → POST → complete('authorized'/outro)
Concorrência:           claim A → 'claimed' | claim B (mesma venda, mesmo instante) → 'busy'
Timeout:                POST falha por rede → complete('pending', mensagem) → lease liberada
Crash:                  processo morre a qualquer momento → lease expira sozinha em 60s
Reconciliação:          claim → 'reconciliation_required' → consulta Focus → reflete estado real
Authorized:              claim → 'already_authorized' → devolve na hora, zero HTTP
```

## E. Evidência de idempotência

`submitNfeHomologacao.concurrency.test.ts`: 12/12 testes. Destaques:
- Claim concorrente (10x simultâneas): exatamente 1 `claimed`, 9 `busy`.
- `Promise.all([submit, submit])`: `issueFocusNfe` chamado **1 vez**.
- Stress test (100x simultâneas): `issueFocusNfe` chamado **no máximo 1 vez**.
- Worker antigo: conclusão com token superado devolve 0 linhas, nunca sobrescreve o resultado do claim vigente.

**Limitação documentada explicitamente**: estes testes rodam contra uma simulação em memória de thread única (Node/JS) — provam que o *service* reage corretamente a cada decisão, não que o Postgres real serializa sob concorrência de processos/conexões de verdade. Essa prova está em `supabase/tests/rpc_claim_fiscal_emission.concurrency.md` (procedimento manual, 2 terminais `psql`, ainda não executado contra um Postgres real nesta sessão — ver seção G).

## F. Recuperação — 5 cenários

- **A** (crash antes do POST): lease expira → consulta → Focus confirma "não encontrado" (404/`nao_encontrado`) → status vira `submission_error` (retentável) → próxima chamada transmite de verdade.
- **B** (crash durante o POST): lease expira → consulta → Focus ainda processando → fica `pending`, nenhum POST imediato.
- **C** (Focus respondeu rejeição, ERP não persistiu): consulta recupera `status_sefaz`/`mensagem_sefaz` reais e persiste.
- **D** (Focus autorizou, ERP não persistiu): consulta recupera chave/número/série/protocolo/XML/DANFE e persiste.
- **E** (já `authorized`): nova tentativa devolve o documento existente, zero `POST`.

## G. Riscos residuais (não provados contra Postgres/Focus reais)

1. O procedimento de 2 terminais (`rpc_claim_fiscal_emission.concurrency.md`) foi escrito mas **não executado** nesta sessão (sem acesso a banco) — a serialização real via `FOR UPDATE` está implementada seguindo o mesmo padrão comprovado de `rpc_claim_outbox_events`, mas precisa ser rodada manualmente antes de confiar 100%. Ver seção I abaixo pro roteiro operacional exato.
2. ~~Janela residual: se uma resposta da Focus demorar MAIS que a lease (60s)...~~ **FECHADO** — ver seção I.1 abaixo (revisão desta mesma fase, ainda antes de qualquer configuração operacional). Resumo: a lease expirar sozinha nunca mais autoriza retransmissão direta depois que uma transmissão HTTP real foi despachada — um novo campo (`submission_started_at`), marcado atomicamente imediatamente antes de `POST /v2/nfe` e guardado pelo claim_token vigente, força `reconciliation_required` incondicionalmente até uma consulta à Focus confirmar inequivocamente a ausência da `provider_ref` (ou até se confirmar que nenhuma transmissão jamais foi despachada).
3. `UNIQUE(access_key)` — não foi criado nenhum teste NOVO de conflito nesta fase (já coberto por `fiscal_documents_constraints.test.sql`, Fase 1).

## H. Próximo passo

Conforme instruído: **parar aqui**. Nenhuma funcionalidade fiscal nova deve ser implementada antes de configurar empresa + token + certificado A1 em homologação e realizar a primeira NF-e Focus real de homologação, validando o happy path real.

## I. Revisão — fechamento do risco residual #2 (mesma fase, antes da configuração operacional)

### I.1 O que mudou

Três estados agora são distinguidos explicitamente (antes só dois existiam: "claim" e "resultado"): **claim adquirido → transmissão iniciada → resultado/reconciliação**.

- Novo campo `fiscal_documents.submission_started_at TIMESTAMPTZ`. Marca quando o `POST /v2/nfe` foi de fato despachado sob o claim vigente. Resetado a `NULL` toda vez que um novo claim é concedido (`rpc_claim_fiscal_emission`).
- Nova RPC `rpc_begin_fiscal_transmission(fiscal_document_id, claim_token, request_payload, fiscal_context_snapshot)` — chamada pelo service **imediatamente antes** de `issueFocusNfe`, guardada pelo claim_token vigente (mesmo padrão de proteção contra worker antigo de `rpc_complete_fiscal_emission`). Substitui a antiga prática de "persistir intenção" via `rpc_complete_fiscal_emission` antes do POST — aquela chamada tinha o efeito colateral de já liberar a lease antes do POST sequer começar, zerando a proteção da lease durante a própria chamada HTTP.
- `rpc_claim_fiscal_emission`: a regra `status = 'pending' → reconciliation_required` foi **substituída** por `submission_started_at IS NOT NULL → reconciliation_required`, incondicional — independente da lease estar ativa ou expirada, e independente do valor de `status`. É um sinal estritamente mais preciso: `status='pending'` fica marcado desde o instante do claim (antes de qualquer HTTP), enquanto `submission_started_at` só existe se uma transmissão real foi despachada.
- `rpc_complete_fiscal_emission` e a reconciliação (`consultAndUpdateFiscalDocument`) agora limpam `submission_started_at` sempre que o resultado gravado for **definitivo** (qualquer status diferente de `pending` — autorizado, rejeição síncrona, erro de autorização, cancelamento, ou confirmação de ausência via 404 da Focus). Só quando o resultado continua genuinamente desconhecido (`pending` — timeout/rede, ou a Focus responde "ainda processando") o campo é preservado. Sem isso, depois da primeira transmissão nenhum claim futuro jamais seria concedido de novo (laço sem saída) — bug real encontrado pelos próprios testes automatizados durante esta revisão.

### I.2 Por que o risco antigo era real

Antes desta revisão: se `issueFocusNfe` demorasse mais que os 60s da lease (ex.: nosso próprio timeout de cliente, 15s, dispara achando que falhou, mas a Focus já recebeu e continua processando), uma segunda execução podia reclamar o documento assim que a lease expirasse, consultar a Focus, receber um "não encontrado" **ambíguo** (a Focus pode não ter processado a transmissão original ainda) e concluir erradamente que era seguro reemitir — abrindo a porta pra duas transmissões HTTP concorrentes com a mesma `provider_ref`. Não foi corrigido aumentando a lease (o pedido proibiu essa saída) — foi corrigido tornando a decisão de reclamar independente da duração da lease a partir do momento em que existe evidência de despacho real.

### I.3 Evidência de idempotência (revisão)

5 novos testes em `submitNfeHomologacao.concurrency.test.ts` (bloco "Fechamento do risco residual #2"), cobrindo exatamente o que foi pedido:
- POST demorando mais que a lease + lease expirando com o POST ainda em voo → uma segunda execução concorrente NUNCA chama `issueFocusNfe` de novo, só reconcilia.
- Crash logo após marcar `submission_started_at` (antes do POST responder) → `reconciliation_required`, zero novo POST.
- Reconciliação depois desse crash (404 confirma ausência) → retentável, e a PRÓXIMA chamada transmite com a MESMA `provider_ref` — nunca uma nova.

3 testes pré-existentes (cenário A, "lease expirada", cenários B/C/D de recuperação de crash) foram revisados pra usar `submission_started_at` corretamente — o cenário A em particular ficou **mais preciso**: se nenhuma transmissão jamais foi despachada (crash durante validação/montagem do payload, antes de `rpc_begin_fiscal_transmission`), a própria primeira chamada seguinte já transmite direto, sem precisar consultar a Focus antes (não há nada pra ela confirmar).

**Total: 578/578 testes, `npm run typecheck` e `npm run build` limpos após a revisão.**

### I.4 O que NÃO mudou

`provider_ref` continua determinística, nunca uma nova por tentativa. `UNIQUE(provider, provider_ref)`, `UNIQUE(access_key) WHERE NOT NULL`, `UNIQUE(sale_id, document_type) WHERE status='authorized'` — intocadas. Nenhuma transação Postgres é mantida durante HTTP. Nenhuma outra funcionalidade fiscal foi tocada (cancelamento, devolução, troca, automação, produção continuam fora de escopo).
