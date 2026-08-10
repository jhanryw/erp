# Plano de Remediação — `sales.products_total`

**Tipo:** proposta de correção em três partes, **não implementada**. Complementa [`products-total-regression-analysis.md`](products-total-regression-analysis.md) (causa raiz e linha do tempo) com os números reais confirmados em [`fiscal-database-validation-results.md`](fiscal-database-validation-results.md). Nenhuma migration, `UPDATE`, `INSERT`, `DELETE`, correção de função ou deploy foi executado.

---

## Números confirmados (não mais estimativa)

- **300 vendas** afetadas (`products_total IS NULL`, `sale_date >= 2026-06-14`), medido diretamente no banco real — a estimativa anterior (~330-350, baseada só no volume mensal informado) estava na ordem de grandeza certa, ligeiramente acima do valor real.
- **171 vendas** anteriores à regressão, **100% preenchidas**, zero exceções.
- **0 vendas** posteriores foram corrigidas organicamente — confirma que o problema é integral e ininterrupto desde a regressão até hoje.
- Amostra de 20 linhas confirma a fórmula (`products_total = subtotal - discount_amount`) sem nenhuma inconsistência, valor negativo, ou interferência de cashback/frete/acréscimo.
- **Ainda não confirmado empiricamente** (consultas propostas, não executadas): quantas das 300 são vendas canceladas/devolvidas, quantas vieram da Nuvemshop, quantas têm pagamento misto. As três seções abaixo tratam essas lacunas explicitamente onde relevante.

---

## Parte 1 — Correção para vendas futuras

**Objetivo:** a partir do momento em que essa correção for autorizada e aplicada, toda nova venda deve gravar `products_total` corretamente, sem repetir a causa raiz identificada (reescrita futura de `rpc_create_sale` partindo de uma cópia desatualizada).

**Proposta:**
```sql
-- Ilustrativo — NÃO EXECUTAR sem autorização expressa
CREATE OR REPLACE FUNCTION public.rpc_create_sale(
  -- ... assinatura de 16 parâmetros da versão vigente (20260704_fix_cashback_expiry_and_earn.sql),
  -- inalterada
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  -- ... todas as variáveis da versão vigente, mais:
  v_products_total  numeric;
BEGIN
  -- ... corpo inalterado até o cálculo de v_gross/v_total
  v_products_total := ROUND(v_subtotal - COALESCE(p_discount_amount, 0), 2);
  -- ... INSERT INTO sales inalterado, exceto por incluir products_total na lista de colunas e v_products_total no VALUES
END;
$$;
```

**Escopo da mudança:** apenas duas linhas conceituais — a declaração da variável e sua inclusão no `INSERT`. Nenhuma outra parte da função é tocada (estoque, cashback, pagamentos, numeração continuam exatamente como estão na versão vigente).

**Achado novo desta rodada de validação, relevante para esta parte do plano:** existe um **segundo overload de `rpc_create_sale`, com 12 parâmetros** (`p_accumulate_cashback ...`), ativo no banco, aparentemente um wrapper de compatibilidade criado deliberadamente em maio/junho de 2026 e nunca atualizado desde `20260610_multi_estoque.sql`. **Esta correção não deve tocar esse wrapper** — ele está fora do escopo desta remediação (é um problema separado, potencialmente sério, registrado em `fiscal-audit-delta-after-sql.md` para decisão à parte). Se o wrapper realmente delega para a função de 16 parâmetros internamente (como o comentário original de 22/05 diz que faz), corrigir a versão de 16 parâmetros pode até corrigi-lo automaticamente — mas isso **precisa ser confirmado lendo o corpo do wrapper antes de presumir**, não deve ser assumido.

**Teste antes de aplicar (proposto, não executado):** criar uma venda de teste (em homologação, se existir até lá, ou cuidadosamente identificada em produção) e conferir que `products_total` bate com `subtotal - discount_amount` imediatamente após a criação.

---

## Parte 2 — Backfill de vendas históricas

**Objetivo:** preencher `products_total` para as 300 vendas hoje nulas, usando a mesma fórmula e abordagem da migration original.

**Proposta:**
```sql
-- Ilustrativo — NÃO EXECUTAR sem autorização expressa
UPDATE public.sales
SET products_total = ROUND(COALESCE(subtotal, 0) - COALESCE(discount_amount, 0), 2)
WHERE products_total IS NULL;
```

Idêntica à instrução já usada no backfill original de `20260613_shipping_fiscal_ready.sql:67-72` — não é uma fórmula nova, é a mesma, reaplicada ao intervalo que ficou de fora.

### Decisão em aberto: vendas canceladas/devolvidas devem participar?

**Não confirmado empiricamente ainda** (proposta de consulta em `fiscal-database-validation-results.md` Seção 5, não executada) quantas das 300 vendas afetadas têm `status` diferente de `'paid'`. Duas leituras possíveis:

- **A favor de incluir todas, independentemente do status:** o backfill original (20260613) não discriminou por status — aplicou a todas as vendas com `products_total IS NULL` na época. `products_total` é um valor descritivo do que os produtos somavam *no momento da venda*, não um indicador de situação atual — permanece um fato histórico válido mesmo que a venda tenha sido cancelada depois. Manter esse precedente evita introduzir uma nova inconsistência (por que só as pagas teriam o campo preenchido, se o campo em si não representa "situação atual"?).
- **A favor de excluir canceladas/devolvidas:** se o único propósito futuro do campo for alimentar snapshots de documento fiscal, e uma venda cancelada nunca teria um documento fiscal `normal` associado (só, no máximo, um documento cancelado ou nenhum), preencher `products_total` nela é irrelevante para esse propósito específico — mas não é incorreto, e não atrapalha nada.

**Recomendação preliminar:** incluir todas, seguindo o precedente da migration original — é a opção que introduz menos regras especiais e menos superfícies de inconsistência futura. Mas esta é uma recomendação, não uma decisão tomada — **precisa de confirmação explícita antes da execução**, e dos números reais (quantas são canceladas) antes de avaliar se a diferença é grande o suficiente para importar.

### Decisão em aberto: vendas da Nuvemshop e pagamento misto

**Confirmado por leitura de código (não ainda por dado real):** o webhook de pedido da Nuvemshop (`src/app/api/webhooks/nuvemshop/order/route.ts`) chama a **mesma** `rpc_create_sale` que o PDV usa — não existe um caminho de criação de venda separado para pedidos de e-commerce. A fórmula `products_total = subtotal - discount_amount` não depende de canal de origem nem de quantas linhas existem em `sale_payments` (pagamento misto é só múltiplas linhas na tabela `sale_payments`, que não participa do cálculo de `subtotal`/`discount_amount` em nenhum ponto do código lido). **Alta confiança, por desenho do sistema, de que a mesma fórmula vale igualmente para vendas Nuvemshop e vendas com pagamento misto** — mas isso não foi testado empiricamente nesta rodada (consultas propostas em `fiscal-database-validation-results.md`, não executadas). Recomendação: rodar essas duas consultas de confirmação antes do backfill, como checagem de baixo custo, não porque haja razão concreta para esperar exceção.

**Validação adicional pelos itens (`sale_items`) — necessária?** Não. A fórmula usa exclusivamente `sales.subtotal`/`sales.discount_amount`, ambos já persistidos e estáveis — não há necessidade de recalcular a partir de `sale_items` (que exigiria somar `unit_price * quantity - discount_amount` por item, replicando exatamente o que `subtotal` já armazena). Validar cruzando com `sale_items` seria uma checagem de integridade *adicional* e opcional (útil só se houvesse suspeita de que `sales.subtotal` em si estivesse corrompido — não há essa suspeita, nada na auditoria sugeriu isso), não uma etapa necessária da reconstrução.

---

## Parte 3 — Validação e rollback

### Validação antes de aplicar em escala
1. **Rodar a amostra em modo `SELECT`, não `UPDATE`**, comparando o valor que seria gravado contra o que já foi manualmente conferido na amostra de 20 linhas (`fiscal-database-validation-results.md`) — nenhuma surpresa esperada, mas custo zero de conferir.
2. **Confirmar ausência de trigger em `UPDATE` de `sales` com efeito colateral inesperado.** A investigação desta rodada de validação já trouxe o inventário completo de triggers em `sales`: `audit_sales` (audita a mudança — sem efeito colateral funcional, só grava log), `trg_customer_metrics_sale` (só dispara em `INSERT`, não em `UPDATE` — **não é afetado**), `trg_generate_cashback` (dispara em `INSERT` **e** `UPDATE` — **requer atenção**, ver abaixo), `trg_sales_updated_at` (só atualiza `updated_at`, inofensivo), `trg_set_sale_number` (só em `INSERT` — não afetado).

   **Ponto de atenção real, novo nesta validação:** `trg_generate_cashback` dispara em `UPDATE` de `sales`, e seu corpo (`trigger_generate_cashback()`) não foi lido nesta auditoria — não está em nenhuma migration rastreada. **Antes de rodar o backfill em massa, é preciso confirmar (via a consulta de `pg_get_functiondef` já proposta em `fiscal-database-validation-results.md` Seção 5) se esse trigger tem alguma condição que o faria reagir a um `UPDATE` que só toca a coluna `products_total`** — se ele, por exemplo, disparasse incondicionalmente a cada `UPDATE` em `sales` e gerasse uma nova transação de cashback a cada backfill, isso corromperia o saldo de cashback de até 300 clientes. **Isto é tratado como um bloqueador do backfill em massa até ser confirmado, não uma formalidade.** Um `UPDATE ... SET products_total = ...` bem escrito normalmente não deveria acionar lógica de negócio pensada para mudança de status/pagamento, mas "normalmente" não é confirmação — a função precisa ser lida antes.
3. **Rodar o backfill primeiro numa única venda de teste** (ou um pequeno lote, ex. 5 vendas), conferir o resultado, só então rodar para as 300.

### Rollback
- **Da correção da função (Parte 1):** reversível sem perda de dado — reverter para o corpo da versão vigente atual (`20260704_fix_cashback_expiry_and_earn.sql`), removendo `v_products_total` e a coluna do `INSERT`. A coluna na tabela continua existindo, só volta a não ser preenchida.
- **Do backfill (Parte 2):** como o valor anterior de todas as 300 linhas era sempre `NULL` (confirmado agora por dado real, não presumido), o rollback é determinístico e seguro:
  ```sql
  -- Ilustrativo — NÃO EXECUTAR sem autorização expressa
  UPDATE public.sales
  SET products_total = NULL
  WHERE sale_date >= '2026-06-14' AND sale_date <= '<data do backfill>';
  ```
  Não há ambiguidade sobre o estado anterior a restaurar.

---

## Sequenciamento em relação à fundação fiscal

Reafirmando o que já está registrado em `products-total-regression-analysis.md`: esta correção **não é pré-requisito da Fase 1 fiscal** — a arquitetura proposta recalcula o equivalente a `vProd` no momento da emissão, não lê `sales.products_total` diretamente. Ver resposta consolidada à pergunta 5 do usuário na seção final deste turno de validação, no encerramento da conversa.

**Nenhuma das três partes foi executada.** Este documento é a proposta completa, aguardando autorização explícita e separada da autorização de qualquer outra fase.
