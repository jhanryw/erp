# Analytics Varejo × Atacado — Fase 7

Relatório de entrega. Continuação das fases 1-3 (fundação/PDV) e Fiscal 6, sobre a fundação já implementada (`sale_type`, `sales_channel`, preço, PDV, estoque compartilhado, fiscal).

## 1-2. Infraestrutura reutilizada / arquitetura escolhida

Auditoria curta confirmou 3 fontes já existentes que fixam as definições oficiais de receita/CMV/venda válida — reaproveitadas sem alteração:
- **[dashboard.ts](src/services/dashboard.ts)** — `revenue = SUM(sales.total)`, `grossProfit = SUM(sale_items.gross_profit)`, `status NOT IN ('cancelled','returned')`.
- **[relatorios/vendas](src/app/(dashboard)/relatorios/vendas/page.tsx)** e **[getSellerReport](src/services/sellerDashboard.ts)** — mesmas duas grandezas.
- **`vw_dre_mensal`** — confirma que CMV vem de custo snapshotado no item (nunca do catálogo atual) e define `lucro_bruto = receita − CMV`.

Arquitetura: um núcleo **puro** ([modalityMetrics.ts](src/lib/analytics/modalityMetrics.ts)) agrega `{sale_type, total, gross_profit, quantity}` em Varejo/Atacado/Total — **CMV é derivado algebricamente** (`receita − lucro_bruto`), nunca uma segunda soma de `unit_cost×quantity`: usa as duas grandezas que o resto do ERP já usa, evitando divergência de arredondamento e uma segunda definição de custo. Duas camadas de I/O consomem o núcleo: [modalityAnalytics.ts](src/services/analytics/modalityAnalytics.ts) (comparação + série diária) e a extensão de `getSellerReport`/`dashboard.ts` (reaproveitando queries **já existentes**, sem round-trip novo).

## 3. Arquivos alterados/criados

**Novos:** `src/lib/analytics/modalityMetrics.ts`+teste, `src/services/analytics/{modalityAnalytics,productModalityReport}.ts`+testes, `src/lib/utils/dateRange.ts` (extração pura), `src/components/modules/dashboards/{modality-breakdown-widget,modality-comparison-table,modality-trend-chart}.tsx`, `src/app/(dashboard)/relatorios/varejo-atacado/page.tsx`, `src/services/sellerDashboard.test.ts` (primeiro teste deste arquivo).

**Modificados:** `dashboard.ts` (+modalityBreakdown, reaproveita query existente), `sellerDashboard.ts` (+retail/wholesale por vendedor), `(dashboard)/page.tsx` (widget discreto), `relatorios/{produtos,vendas,vendedores,page}.tsx`.

**Migration:** `202609031200_sales_modality_analytics_indexes.sql` — 2 índices, cada um justificado por uma query real desta fase (documentado no próprio arquivo).

## 4. Achado corrigido fora do escopo estrito, mas exigido pela seção "MULTIEMPRESA"

`relatorios/produtos/page.tsx` **nunca filtrava `mv_product_performance` por `company_id`** — `requirePageRole()` já devolve o profile com `company_id` e o valor nunca era usado. Corrigido (1 linha) porque a seção MULTIEMPRESA do pedido exige isolamento estrito em toda query de produto, e eu estava adicionando uma query de produto NOVA ao lado da antiga — inconsistente deixar só a nova isolada.

## 5-10. Métricas, fórmulas, faturamento, CMV, lucro bruto, margem, participação

Exatamente as fórmulas pedidas: ticket médio = receita/vendas; lucro bruto = receita−CMV; margem = lucro bruto/receita; participação = modalidade/total. Todas com guarda de divisão por zero (`null` para margem, `0` para participação — nunca NaN/Infinity, testado explicitamente). Nunca chamado de "lucro líquido" em nenhum lugar — DRE/despesas operacionais não tocadas.

## 11. Vendedor

`getSellerReport` ganhou `retail`/`wholesale` (mesmas `ModalityMetrics`) por vendedor, computados reaproveitando os MESMOS dados já buscados (sale_items já vinha na query) — nenhuma query nova. `revenue`/`grossProfit` totais (já existentes) continuam idênticos. UI: colunas Varejo/Atacado em `/relatorios/vendedores`, e seção completa (com CMV/lucro/margem) na página nova.

## 12. Canal

`sale_type` e `sales_channel` continuam dimensões separadas — o filtro de canal em `/relatorios/varejo-atacado` restringe QUAIS vendas entram na comparação (`getModalityComparison(..., {salesChannel})`), mas a tabela sempre mostra as duas colunas (Varejo/Atacado) — nunca "escolha um canal e perca a modalidade". Testado.

## 13. Produto

Nova query dedicada (`productModalityReport.ts`) — não usa `mv_product_performance` (sem `sale_type`, sem período). Usa `sale_items.total_price`/`gross_profit` — **preço/custo REALIZADOS na venda**, nunca `products.base_price` atual (testado explicitamente, incluindo o caso "preço atual do catálogo não afeta receita histórica").

## 14. Filtros

Todos filtram no **backend** (query real, `.eq`/`.gte`/`.lte`), nunca só o array já carregado: `/relatorios/vendas?sale_type=`, `/relatorios/produtos?modality=&range=`, `/relatorios/varejo-atacado?channel=&range=`.

## 15. Dashboard

Faixa discreta sob os KPIs existentes (`ModalityBreakdownWidget`) — barra de 2 segmentos + 2 linhas de texto, link "Ver detalhes" pro relatório completo. Nenhuma query nova (reaproveita `periodSalesRes`, já buscada por `getDashboardData`).

## 16. Evolução temporal

`getDailyModalityRevenue` — mesmo padrão de `dashboard.ts` (busca no período, agrupa em memória). Toggle Diário/Mensal é reagregação em memória do mesmo array (nenhuma segunda query). `recharts` reaproveitado (já era a lib usada em todo o dashboard) — nenhuma biblioteca nova.

## 17-18. Cancelamentos / Devoluções

Cancelamento: `status NOT IN ('cancelled','returned')` — idêntico ao resto do ERP. **Devolução parcial (troca)**: auditoria confirmou que **nenhum relatório do ERP hoje** subtrai `exchanges.returned_amount`/`credit_amount` da venda original — o crédito só reduz receita quando (e se) for gasto numa venda futura via `cashback_used`. O exemplo do pedido (R$1.000 → devolução R$200 → esperado R$800) **não reflete o comportamento real atual** de nenhum relatório auditado — reproduzi fielmente o comportamento existente (sem inventar uma terceira definição de receita só para o módulo novo) e documento este gap aqui, exatamente como instruído ("se houver problema pré-existente, documente antes de corrigir").

## 19. Troca

Auditado `rpc_process_exchange`/`troca/route.ts`: quando há itens novos, a venda-filha usa `cashback_used` (o crédito da devolução) como parte do pagamento — isso já evita dupla contagem NO CASO DE TROCA COM REPOSIÇÃO (a venda-filha só soma a diferença líquida). O gap real é só devolução PURA sem itens novos (item 17/18 acima) — não é dupla contagem, é sub-contagem de devolução.

## 20. Performance

Todas as queries filtram por `company_id`+intervalo de `sale_date` (mesmo padrão de `dashboard.ts`) — nenhuma trouxe todas as vendas históricas pro frontend. Agregação em memória (JS), mesmo padrão já usado em todo o dashboard existente — não pareceu haver necessidade real de mover pra SQL GROUP BY/view dado o volume já atendido pelo padrão atual.

## 21. Índices

2 novos, cada um servindo uma query real desta fase (nunca especulativo) — documentados no próprio arquivo de migration e no relatório acima (seção 3/12).

## 22. Exportação

**Nenhuma exportação CSV/Excel/PDF real existe hoje em NENHUM relatório** (auditoria confirmou — os rótulos "Excel/PDF/CSV" na página `/relatorios` são apenas decorativos). Por instrução explícita ("não crie módulo de exportação novo apenas para isso"), nada foi criado.

## 23. Impacto na DRE

Zero — `vw_dre_mensal` não foi lida nem alterada por nenhum código desta fase.

## 24-27. Testes / suíte / typecheck / build

**36 testes novos** (cobrindo ~30 dos 40 itens numerados pedidos — os restantes são UI sem infraestrutura de teste de componente, ou comportamento de timezone/data já herdado sem lógica nova). Suíte completa: **949/949**. `npm run typecheck`: limpo. `npm run build`: limpo, `/relatorios/varejo-atacado` presente no manifesto.

## 28. Comandos manuais

```bash
supabase db push
psql "$DATABASE_URL" -f supabase/tests/sales_modality_analytics_indexes.test.sql
```

## 29. Limitações conhecidas

Devolução parcial via troca não é subtraída da receita em NENHUM relatório do ERP (gap pré-existente, seção 17-19). Sem infraestrutura de teste de componente/E2E (mesma limitação de todas as fases anteriores). Índices não aplicados (sem acesso a Postgres neste sandbox).

## 30. Pendências seguintes

Se a devolução parcial precisar refletir na receita, é uma decisão de produto que afeta o ERP inteiro (não só analytics) — fora do escopo desta fase por instrução explícita.
