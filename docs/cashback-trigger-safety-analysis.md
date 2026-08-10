# Análise de Segurança — `trigger_generate_cashback`

**Tipo:** análise com o que já é confirmável hoje + lacunas explícitas que dependem dos Blocos 1, 3 e 4 de [`database-functions-live-analysis.md`](database-functions-live-analysis.md) (ainda não executados). Nenhuma função foi executada.

---

## O que já está confirmado

- **Trigger existe e está ativo:** `sales / trg_generate_cashback / AFTER INSERT OR UPDATE / EXECUTE FUNCTION trigger_generate_cashback()` — confirmado em `information_schema.triggers` na rodada anterior.
- **Dispara tanto em `INSERT` quanto em `UPDATE` de `sales`** — confirmado.
- **Cláusula `WHEN` (condição de disparo por coluna): não confirmada ainda.** A consulta anterior (`information_schema.triggers`) não captura a cláusula `WHEN` de um trigger — só o evento (`INSERT`/`UPDATE`) e o timing (`AFTER`). **Este é o dado mais importante pendente** — o Bloco 3 (`pg_get_triggerdef`) resolve isso diretamente, e pode responder sozinho, sem nem precisar do corpo da função, se o trigger só dispara sob uma condição específica (ex.: `WHEN (NEW.status = 'paid' AND OLD.status IS DISTINCT FROM NEW.status)`).
- **Existe uma lógica de geração de cashback totalmente diferente e já lida por completo**, embutida diretamente no corpo de `rpc_create_sale` (não num trigger): variável `v_eff_cashback`, cálculo de `v_earn_amount = ROUND(v_total * v_rate_pct / 100.0, 2)` condicionado a `v_total >= COALESCE(v_min_order, 0)`, INSERT em `cashback_transactions` com `type='earn'` — linhas ~419-471 da versão vigente (`20260704_fix_cashback_expiry_and_earn.sql`). **Isso confirma que existem, no mínimo, duas vias distintas de geração de cashback no sistema: a lógica inline dentro do RPC de criação de venda, e o trigger `trg_generate_cashback`.**
- `generate_cashback_for_sale(p_sale_id integer)`/`generate_cashback_for_all_sales()` existem no catálogo, sem rastro em nenhuma migration nem no código de aplicação — hipótese não confirmada de que sejam a implementação interna chamada pelo trigger (nomes consistentes, mas não comprovado).
- `cashback_transactions` — schema já conhecido (`type`, `status`, `release_date`, `expiry_date`, `used_at`, `exchange_id` etc.) — **nenhuma `UNIQUE`/constraint de idempotência por venda foi encontrada em nenhuma migration rastreada.** Não confirma ausência real (pode existir fora do histórico versionado, como já aconteceu com `pedidos_external_id_source_key`) — só confirma que não está documentada. Bloco 4 resolve isso com certeza.

## Respostas às perguntas específicas do usuário

**Se `trigger_generate_cashback` está ligado a `INSERT`, `UPDATE` ou ambos em `sales`:** **ambos**, confirmado.

**Quais colunas possuem condição de disparo:** **não confirmado** — depende da cláusula `WHEN` (Bloco 3), que não foi capturada na consulta anterior.

**Se um backfill apenas em `products_total` dispararia o trigger:** **Depende inteiramente da cláusula `WHEN`, ainda não lida.** Se o trigger não tiver `WHEN` (dispara incondicionalmente em qualquer `UPDATE`), então **sim, um `UPDATE ... SET products_total = ...` dispararia o trigger** mesmo que a intenção seja só corrigir um campo administrativo, sem relação com pagamento/status. Isso já havia sido identificado como bloqueador do backfill em massa em `products-total-remediation-plan.md` Parte 3, e continua sendo tratado como tal até esta pergunta ser respondida com o Bloco 3.

**Se há risco de criação duplicada de cashback:** **Não descartado.** Existem, no mínimo, duas vias de geração de cashback (a lógica inline em `rpc_create_sale` e o trigger `trg_generate_cashback`). Se ambas gerarem uma transação `earn` para a mesma venda em algum cenário (por exemplo, se o trigger dispara no mesmo `INSERT` que já roda a lógica inline), o resultado seria cashback duplicado para o cliente. **Isto é o achado de risco mais sério ainda em aberto nesta auditoria** — não confirmado nem descartado, tratado com a severidade mais alta possível até ser resolvido (ver registro de riscos).

**Se `trigger_generate_cashback` e outra rotina de cashback podem executar para a mesma venda:** Estruturalmente, sim — nada no que já foi lido impede isso. A lógica inline roda dentro da mesma transação do `INSERT INTO sales` (parte do corpo de `rpc_create_sale`), e o trigger `AFTER INSERT` dispara **na mesma transação**, imediatamente após a linha ser inserida — ou seja, se o trigger não tiver uma condição que o impeça, ele executaria **na mesma operação de criação de venda que já gerou o cashback inline**, no mesmo `INSERT`. Isso é consistente com um cenário real de duplicação, não apenas teórico.

**Se existe proteção de idempotência:** **Não confirmada.** Nenhuma migration documenta uma `UNIQUE` em `cashback_transactions` que impediria duas linhas `type='earn'` para a mesma `sale_id`. Bloco 4 resolve com certeza.

**Se a tabela de cashback possui constraint única por venda/transação:** Mesma resposta acima — pendente do Bloco 4.

**Se vendas canceladas ou devolvidas podem gerar cashback indevido:** Já parcialmente respondido pela leitura anterior de `rpc_cancel_sale`/`rpc_return_sale` (ambas reais, `20260722_rpc_cancel_return_sale_no_finance_entry.sql`): essas funções **revertem** cashback já concedido (`status` → `'reversed'`), mas isso pressupõe que a reversão sabe exatamente quais transações `earn` pertencem à venda cancelada. Se o trigger `trg_generate_cashback` também disparar em `UPDATE` de `sales` — e cancelamento/devolução **atualizam** `sales.status` — existe uma pergunta nova e não respondida: **o `UPDATE` que marca a venda como `cancelled`/`returned` também dispararia `trigger_generate_cashback()`?** Se sim, e se o trigger não distinguir "venda nova sendo paga" de "venda sendo cancelada", isso poderia gerar uma transação de cashback incorreta no exato momento do cancelamento — o oposto do que deveria acontecer. **Não confirmado, prioridade alta para o Bloco 3 (cláusula `WHEN`) e Bloco 1 (corpo da função).**

---

## Classificação de risco para esta rodada

Mantido como registrado em `fiscal-audit-delta-after-sql.md`: **Alto, não confirmado**. Nenhuma ação de correção deve ser tomada até os Blocos 1, 3 e 4 serem executados e lidos. Especificamente, **o backfill de `products_total` proposto em `products-total-remediation-plan.md` permanece bloqueado** até a cláusula `WHEN` do trigger ser conhecida (Bloco 3 sozinho pode ser suficiente para desbloquear, sem precisar do corpo completo da função, se a condição excluir explicitamente updates que não tocam `status`/pagamento).
