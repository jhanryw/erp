# Mapa da Fonte de Dados — Auditoria Financeira/Comercial/Estoque (Santtorini, 2026-08-28)

**Método**: leitura estática de `supabase/migrations/*.sql` (156 arquivos, única fonte de verdade confiável — `DATABASE_SCHEMA.sql` na raiz é um dump de 23/mar, **desatualizado e não usado aqui**) + `src/services/dashboard.ts`, `sellerDashboard.ts`, `src/lib/analytics/modalityMetrics.ts` para confirmar quais definições o próprio ERP já usa em produção. Cruzado com dois relatórios de auditoria já produzidos nesta mesma base 3 dias atrás (`docs/varejo-atacado-audit-report.md`, `docs/analytics-fase7-varejo-atacado.md`).

**Nenhuma linha deste documento foi obtida executando SQL contra o banco real** — é 100% leitura de schema/código. Toda vez que um número aparecer, é porque veio do dono ou de execução real futura, nunca inventado aqui.

---

## 0. Identificação de empresa (company_id)

| Item | Detalhe |
|---|---|
| Tabela | `companies` — **achado importante**: não existe `CREATE TABLE companies` em nenhuma das 156 migrations rastreadas. Junto com `stock_movements`, é uma tabela-base que já existia antes do histórico de migrations começar (mesmo padrão já documentado em memória: `products.tipo/modelo/ano` também não tem migration de criação rastreável). |
| Como resolver | `SELECT id, name FROM companies;` — dado o padrão do projeto ("hoje só existe a Santtorini", comentário em `20260810_vw_daily_revenue_trend.sql`), é muito provável que exista **uma única linha**. Precisa confirmar antes de qualquer filtro. |
| Uso | Todo `company_id` usado nas queries abaixo vem dessa linha. `users.company_id` também serve como atalho (`SELECT DISTINCT company_id FROM users`). |
| Limitação | Não posso cravar o nome exato da coluna de identificação (`name` é o mais provável, mas não confirmado) sem `SELECT * FROM companies LIMIT 5`. |

---

## 1. Vendas

| Campo | Detalhe |
|---|---|
| Tabela | `sales` |
| Campos-chave | `id, sale_number, company_id, customer_id, seller_id (user autenticado), responsible_seller_id (→ sellers.id, vendedor real), status, subtotal, discount_amount, discount_pct, cashback_used, shipping_charged, total, payment_method (legado — ver §14), sale_origin (canal de marketing, enum customer_origin), sale_type ('retail'/'wholesale', default retail), sales_channel (nullable: pos/manual/whatsapp/nuvemshop/wholesale_site), sale_date, cancelled_at/cancelled_by, returned_at/returned_by, receipt_token` |
| Venda válida | **Duas definições coexistem no código — precisa escolher uma e declarar** (ver §P do relatório final): <br>(A) `status NOT IN ('cancelled','returned')` — usada por `dashboard.ts`, `sellerDashboard.ts`, `mv_product_performance`, `mv_daily_sales_summary`, `modalityMetrics.ts`. Inclui `pending`.<br>(B) `status IN ('paid','shipped','delivered')` — usada só por `vw_daily_revenue_trend`. Exclui `pending` explicitamente.<br>**Esta auditoria vai usar (A)** por ser a definição dominante (5+ consumidores vs. 1), mas vou reportar quantas vendas `pending` existem no período — se for material, a diferença entre A e B importa. |
| Filtro obrigatório | `company_id = <id_santtorini>` em toda query — `sales` tem a coluna nativa. |
| Limitações | `sale_date` é a data comercial "oficial" (fuso America/Fortaleza), não `created_at`. Editável posteriormente via `PATCH /editar` — não há trilha de auditoria de mudança de `sale_date` fora de `audit_log` genérico. `payment_method` na própria linha de `sales` é **legado**: a fonte real de forma de pagamento é `sale_payments` (§14) desde 22/05 — pode haver vendas antigas só com o campo legado preenchido. |

## 2. Itens das vendas

| Campo | Detalhe |
|---|---|
| Tabela | `sale_items` |
| Campos-chave | `id, sale_id, product_variation_id, stock_lot_id (lote FIFO consumido), quantity, unit_price (preço no momento da venda), unit_cost (custo do lote consumido, sempre recalculado no servidor — nunca confia no client), discount_amount, total_price, gross_profit (coluna gerada: total_price − unit_cost×quantity)` |
| Filtro | Join com `sales` filtrado por `company_id` e `status` (não tem `company_id` própria). |
| Limitações | `unit_price` **não é validado contra o catálogo atual** no servidor — é o preço real cobrado, correto para receita histórica, mas pode divergir do preço atual do produto (isso é o comportamento correto para auditoria de faturamento, só não use para saber "quanto custa hoje"). `gross_profit` já vem pronto — nunca recalcular subtraindo `unit_cost×quantity` de novo por fora (evita divergência de arredondamento). |

## 3. Produtos

| Campo | Detalhe |
|---|---|
| Tabela | `products` |
| Campos-chave | `id, company_id, name, sku, category_id, subcategory_id (nunca populado — sempre NULL, confirmado em auditoria anterior), brand_id, supplier_id, origin (own_brand/third_party), base_cost, base_price, wholesale_price (nullable), cst (reservado, não usado pelo motor fiscal), margin_pct/markup_pct (colunas GERADAS), active` |
| Filtro | `company_id = <id>` |
| Limitações | `margin_pct`/`markup_pct` são calculados sobre `base_price`/`base_cost` **atuais do cadastro**, não sobre o que foi realizado na venda — para margem realizada, usar `sale_items.gross_profit`, nunca essas colunas geradas. |

## 4. Variantes

| Campo | Detalhe |
|---|---|
| Tabela | `product_variations` (SKU por combinação cor/tamanho) + `product_variation_attributes` (N:N) + `variation_types`/`variation_values` (cor/tamanho reais) |
| Campos-chave | `product_variations.id, product_id, sku_variation, cost_override (NULL=usa base_cost do pai), price_override (NULL=usa base_price do pai), wholesale_price_override, active` |
| Cor/Tamanho | **Nunca estão em coluna direta de `product_variations`** (`pv.color`/`pv.size` não existem — já foi bug real corrigido 2x, em `vw_stock_live` e `vw_purchase_suggestions`). Sempre via: `product_variation_attributes pva JOIN variation_types vt ON vt.id=pva.variation_type_id JOIN variation_values vv ON vv.id=pva.variation_value_id`, filtrando `vt.slug IN ('cor','tamanho')`. |
| Limitações | Preço efetivo de uma variação = `COALESCE(price_override, products.base_price)` — nunca usar `price_override` sozinho. |

## 5. Estoque atual

| Campo | Detalhe |
|---|---|
| Tabela | `stock_balances` (fonte de verdade **desde 10/06/2026**) + `stock_locations` |
| Campos-chave | `stock_balances.product_variation_id, stock_location_id, quantity, avg_cost`. `stock_locations.is_main_store` marca o local principal. |
| Views prontas | `vw_stock_live` (por variação, já junta produto/cor/tamanho/valor a custo/valor a preço/flags `out_of_stock`/`low_stock` ≤3un) — **view normal, sempre atual, não materializada**. `mv_stock_status` (materializada, tem `company_id` desde 12/08, mas precisa `REFRESH MATERIALIZED VIEW` manual — pode estar desatualizada). |
| Limitações críticas | Tabela legada `stock` (singular) está **congelada desde 10/06** — não escrita mais, mas ainda existe e **já causou bug real** (duas MVs liam dela por engano, corrigido em migrations de 10/08 e 13/08). Nunca usar `stock` para número atual. `stock_balances` é por local — se a empresa tiver mais de 1 local ativo, "estoque atual" de um produto é `SUM(quantity)` entre locais, não a linha de um local só. |

## 6. Movimentações de estoque

| Campo | Detalhe |
|---|---|
| Tabela | `stock_movements` (base pré-existente, sem migration de criação rastreável — mesmo padrão de `companies`) |
| Campos confirmados | `product_variation_id, quantity, source_location_id, destination_location_id, movement_type ('entry','sale','transfer','adjustment','return','initial'), reference_type ('sale','lot','exchange','transfer','manual'), notes, created_by, created_at` (created_at não confirmado no nome exato — checar). |
| Limitações | Estrutura-base não tem migration de criação — colunas exatas de timestamp/id precisam confirmação via `information_schema.columns`. |

## 7. Custo dos produtos

| Campo | Detalhe |
|---|---|
| Cadastro | `products.base_cost` / `product_variations.cost_override` (custo de catálogo — **estático**, não FIFO real apesar de o schema ter sido desenhado para FIFO via `stock_lots`). |
| Custo real de venda | `sale_items.unit_cost` — resolvido em `resolveAuthoritativeItemCosts()` no momento da venda, a partir de `cost_override`/`base_cost`, **nunca do lote FIFO realmente consumido** (achado de auditoria anterior: existe uma função `consume_stock_fifo` no banco, mas é código morto, nunca chamada). |
| Custo do estoque parado | `stock_balances.avg_cost` (média ponderada, atualizada a cada entrada em `stock_lots`) — este sim reflete custo real de compra. |
| Limitação importante | **CMV do DRE e CMV de `sale_items` vêm do custo de CATÁLOGO no momento da venda, não de FIFO real.** Isso é uma limitação estrutural conhecida do ERP (não desta auditoria) — qualquer GMROI/margem calculado aqui herda essa limitação. |

## 8. Preço de venda

| Campo | Detalhe |
|---|---|
| Catálogo | `products.base_price` (varejo) / `products.wholesale_price` (atacado, nullable) — variação pode sobrescrever via `price_override`/`wholesale_price_override`. |
| Realizado | `sale_items.unit_price` — este é o preço correto para toda análise histórica de faturamento (nunca `base_price` atual, que pode ter mudado desde a venda). |

## 9. Categorias

| Campo | Detalhe |
|---|---|
| Tabela | `categories` — `id, name, slug, parent_id (hierarquia), active`. Seed conhecido: calcinha, conjunto, sutiã com bojo, sutiã sem bojo, sutiã adesivo, sutiã de silicone, camisola, pijama americano, pijama rendado — mas **isso é o seed original, categorias podem ter sido adicionadas/renomeadas desde então**, confirmar com `SELECT * FROM categories WHERE company_id=...` antes de filtrar "calcinha" por nome fixo. |
| Limitação | `subcategory_id` em `products` nunca é populado (sempre NULL) — não é dimensão útil. |

## 10. Fornecedores

| Campo | Detalhe |
|---|---|
| Tabela | `suppliers` — `id, name, document (CPF/CNPJ), phone, city, state, active`. Vínculo: `products.supplier_id` (fornecedor do produto) e `stock_lots.supplier_id` (fornecedor de cada entrada — pode divergir do cadastro do produto se produto trocou de fornecedor). |
| View pronta | `mv_supplier_performance` (materializada, v2 desde 15/06 — confirmar se tem `company_id`, não confirmado nesta leitura). |

## 11. Compras / entradas de estoque

| Campo | Detalhe |
|---|---|
| Tabela | **`stock_lots`** — é a tabela de compras/entradas (não existe módulo "purchase_orders" separado). `id, product_variation_id, supplier_id (NULL=produção própria), entry_type ('purchase'/'own_production'), quantity_original, quantity_remaining (decrementado por saídas FIFO — mas ver §7, FIFO real não é consumido na prática), unit_cost, freight_cost, tax_cost, total_lot_cost (gerada), cost_per_unit (gerada), entry_date, created_by`. |
| Uso nesta auditoria | Fonte de "última entrada" (`vw_stock_live.last_entry_date`), de fornecedor recomendado (`vw_purchase_suggestions`) e de custo de reposição (`avg_cost_per_unit` últimos 180 dias). |
| Limitação | Não existe conceito de "pedido de compra" pendente/aberto — só entrada já confirmada. Sem campo de "despesas futuras de compra" aqui — isso, se existir, estaria em `finance_entries` (§12/13) como categoria `stock_purchase`, sempre já uma saída de caixa efetivada. |

## 12. Despesas / 13. Financeiro

| Campo | Detalhe |
|---|---|
| Tabela | `finance_entries` — livro-razão único (receitas E despesas). `id, company_id, type ('income'/'expense'), category (enum finance_category), description, amount, reference_date (data de COMPETÊNCIA), sale_id, stock_lot_id, marketing_cost_id, return_id, payment_method, paid_at (DATE, quando foi de fato pago — nullable), cash_movement_id, created_by` |
| Categorias reais (enum `finance_category`) | Receita: `sale`, `cashback_used`, `other_income`. Despesa: `stock_purchase`, `freight_cost`, `marketing`, `rent` (aluguel), `salaries` (salários), `operational`, `taxes` (impostos), `other_expense`. **Mapeamento direto para o que o dono pediu** — marketing/aluguel/salários/operacional/impostos/frete/outras já existem como categorias nativas, não precisa inferir. |
| View pronta (DRE) | `vw_dre_mensal` (versão vigente: `20260725_vw_dre_mensal_margem_operacional_pct.sql`) — 1 linha por mês+company_id: `receita_bruta, descontos, receita_liquida, cmv, lucro_bruto, margem_bruta_pct, marketing, aluguel, salarios, operacional, impostos, frete, outras_despesas, total_opex, resultado_operacional, margem_operacional_pct`. Trata cancelamento/devolução por **data do evento** (`cancelled_at`/`returned_at`), não retroage no mês da venda original — decisão de "competência estável" documentada no próprio SQL. |
| Contas a pagar futuras | **Não existe conceito de "despesa futura agendada"** em `finance_entries` — toda linha é lançamento já ocorrido (`reference_date` é data de competência do passado/presente, `paid_at` confirma pagamento). Se o dono tem despesas futuras controladas, é fora do ERP (planilha externa) — vou confirmar isso explicitamente na auditoria, não presumir. |
| Limitação | `mv_monthly_financial` (materializada, alternativa a `vw_dre_mensal`) **não tem `company_id`** — não usar se houver mais de 1 empresa; preferir `vw_dre_mensal` ou query direta em `finance_entries` com filtro explícito. |

## 14. Formas de pagamento

| Campo | Detalhe |
|---|---|
| Tabela | `sale_payments` (desde 22/05, multi-forma por venda) — `id, sale_id, company_id, method (pix/cash/credit_card/debit_card; 'card' é legado), amount_tendered, change_amount, change_method, net_amount, installments, card_brand, acquirer, fee_percentage, fee_amount (taxa de adquirente — exatamente o que o dono pediu em "taxas de pagamento, se registradas"), metadata` |
| Limitação | Vendas anteriores a 22/05/2026 só têm `sales.payment_method` (single, sem taxa registrada) — `sale_payments` não existe retroativamente para elas. Checar quantas vendas do período cobrem cada fonte. |

## 15. Cancelamentos / 16. Devoluções

| Campo | Detalhe |
|---|---|
| Cancelamento | `sales.status='cancelled'` + `cancelled_at`/`cancelled_by` (desde 21/07 — vendas canceladas antes disso podem não ter o timestamp preenchido). RPC `rpc_cancel_sale` só faz UPDATE, não recria linha — histórico do item original é preservado em `sale_items`. |
| Devolução total | `sales.status='returned'` + `returned_at`/`returned_by`. Tabela auxiliar `returns`/`return_items` (`type` 'return'/'exchange', `reason`, `total_refunded`) — mais granular, mas **auditoria anterior não confirmou se `returns` é populada pelo mesmo fluxo de `rpc_return_sale`** ou é um mecanismo paralelo/legado — vou verificar contagem de linhas antes de usar. |
| Devolução/troca parcial | `exchanges`/`exchange_items` — **achado crítico já documentado (Fase 7 analytics, 03/09)**: nenhum relatório do ERP hoje subtrai `exchanges.returned_amount` da venda original. O crédito só reduz receita futura quando gasto (`sales.cashback_used`). Isso significa que "faturamento líquido" desta auditoria, se seguir o padrão do próprio ERP, **não desconta trocas parciais puras** — vou reportar isso como limitação explícita, não uma correção silenciosa. |

## 17. Descontos

| Campo | Detalhe |
|---|---|
| Nível venda | `sales.discount_amount` (R$), `sales.discount_pct` (informativo, não usado em cálculo) |
| Nível item | `sale_items.discount_amount` |
| Limitação | Sem teto percentual no schema (achado de auditoria anterior) — desconto pode ser qualquer valor até o subtotal (`CHECK discount_amount <= subtotal`). |

## 18. Impostos

| Campo | Detalhe |
|---|---|
| Lançamento contábil | `finance_entries` categoria `taxes` — só entra se alguém lançar manualmente; não há cálculo automático de imposto sobre venda no financeiro. |
| Fiscal (NF-e/NFC-e) | `fiscal_documents`/`fiscal_document_items` (CSOSN/CFOP snapshotados por linha na emissão) — mas ambiente é **só homologação** (código bloqueia produção), e nem toda venda tem documento fiscal emitido (emissão manual pós-venda). **Não confiar em `fiscal_documents` para "quanto pagamos de imposto"** — é regime de Simples Nacional/MEI (CSOSN, sem ICMS destacado tradicionalmente) e cobre só uma fração das vendas (as que tiveram nota emitida). |

## 19. Canais de venda

| Campo | Detalhe |
|---|---|
| Dimensões (3 distintas, não confundir) | `sale_origin` (canal de **marketing** do cliente: instagram/referral/paid_traffic/website/store/other) · `sales_channel` (canal **operacional**: pos/manual/whatsapp/nuvemshop/wholesale_site — nullable, só populado onde há sinal inequívoco: Nuvemshop sempre grava, PDV manual fica NULL até hoje) · `sale_type` (retail/wholesale). |
| Limitação | `sale_origin='website'` é ambíguo entre pedido real da Nuvemshop e venda manual marcada como site pelo operador — sinal confiável de "veio da Nuvemshop" é `pedidos.source='nuvemshop'` + `pedidos.sale_id`, não `sale_origin`. |

---

## Views/Materialized Views prontas (inventário completo, para não reinventar SQL)

| View | Tipo | company_id? | Uso nesta auditoria |
|---|---|---|---|
| `vw_stock_live` | view | via join (não filtra sozinha, `products.company_id`) | Estoque atual por variação (§5) |
| `vw_purchase_suggestions` | view | idem | Matriz de reposição (§6 do pedido) — já calcula velocidade, cobertura, urgência, fornecedor recomendado |
| `vw_dre_mensal` | view | sim | DRE mensal (§9) |
| `vw_daily_revenue_trend` | view | sim (partition) | Tendência diária + médias móveis 7/30d **já prontas** (§1 do pedido) — mas usa definição (B) de venda válida, diferente do resto |
| `vw_data_quality_issues` | view | sim (corrigido 25/08) | Inconsistências (§P do pedido) |
| `mv_product_performance` | matview | sim (desde 12/08) | Base para ABC |
| `mv_abc_by_revenue/profit/volume` | matview | via product_id → produto | Curva ABC pronta, mas **sem filtro de período** (é histórico total, não só jun-ago) — vou recalcular por período manualmente |
| `mv_stock_status` | matview | sim (desde 12/08) | Alternativa a vw_stock_live (cuidado: precisa REFRESH manual) |
| `mv_customer_rfm`, `mv_daily_sales_summary`, `mv_monthly_financial`, `mv_color_performance` | matview | **NÃO têm company_id** (gap conhecido, não corrigido) | Evitar usar diretamente — preferir query direta filtrada |
| `mv_supplier_performance` | matview | não confirmado | Fornecedores |

---

## Inconsistências/limitações já conhecidas que afetam esta auditoria (adiantando a seção P do relatório final)

1. Duas definições de "venda válida" coexistem (`NOT IN cancelled,returned` vs. `IN paid,shipped,delivered`) — vou declarar qual uso em cada tabela.
2. CMV nunca é FIFO real, sempre custo de catálogo no momento da venda — GMROI/margem herdam essa limitação.
3. Trocas parciais não são descontadas da receita em nenhum relatório existente — vou seguir o mesmo padrão e apontar o efeito.
4. 4 materialized views sem `company_id` — não serão usadas diretamente.
5. `companies` e `stock_movements` não têm migration de criação rastreável — confirmar estrutura exata via `information_schema` antes de tudo.
6. `mv_abc_by_*` são histórico acumulado, não recalculam por período — vou construir a curva ABC do período pedido via SQL próprio, não reaproveitar essas MVs diretamente (mas usar a mesma metodologia de corte 80/95%).
