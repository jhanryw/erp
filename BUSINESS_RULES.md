# Santtorini ERP — Bloco 3: Regras de Negócio

---

## 3.1 Cálculo de Margem e Markup

### Margem (Margin %)
```
margem = ((preço_venda - custo) / preço_venda) × 100
```
- Representa quanto do preço de venda é lucro bruto
- Usada em relatórios e dashboards de rentabilidade
- Armazenada como coluna gerada `margin_pct` em `products`

### Markup (%)
```
markup = ((preço_venda - custo) / custo) × 100
```
- Representa quanto o preço é maior que o custo
- Usado internamente para referência de precificação

### Margem Realizada (por venda)
```
margem_realizada = ((unit_price - unit_cost) / unit_price) × 100
```
- Calculada com `unit_cost` do lote real consumido (FIFO)
- Diferente da margem cadastrada (que usa `base_cost`)
- Usada nos dashboards de margem real vs. margem planejada

### Custo por Unidade do Lote
```
cost_per_unit = (unit_cost × qty + freight_cost + tax_cost) / quantity_original
```
- Calculado na criação do lote (`stock_lots.cost_per_unit`)
- Imutável após criação do lote
- É o custo usado no `sale_items.unit_cost`

---

## 3.2 Cálculo de Lucro

### Lucro Bruto por Item
```
gross_profit_item = (unit_price × quantity) - (unit_cost × quantity) - discount_item
```

### Lucro Bruto por Venda
```
gross_profit_sale = SUM(sale_items.gross_profit)
```

### Lucro Líquido por Venda
```
lucro_liquido = gross_profit_sale
              - (custo_frete_real - frete_cobrado_cliente)
              - cashback_gerado_nessa_venda
              - custo_marketing_proporcional  ← opcional, calculado no relatório
```
> O custo de marketing proporcional é calculado apenas nos relatórios de DRE.
> No nível de item/venda, o lucro líquido é o lucro bruto menos ajustes de frete e cashback.

### DRE (nível mensal)
```
Receita Bruta           = SUM(sales.total) para o mês
(-) Devoluções          = SUM(returns.total_refunded) para o mês
= Receita Líquida

(-) CMV (Custo Mercadoria Vendida) = SUM(sale_items.unit_cost × quantity)
= Lucro Bruto

(-) Despesas Operacionais
    Marketing           = SUM(marketing_costs.amount)
    Aluguel             = SUM(finance_entries WHERE category = 'rent')
    Salários            = SUM(finance_entries WHERE category = 'salaries')
    Impostos            = SUM(finance_entries WHERE category = 'taxes')
    Outros              = SUM(finance_entries WHERE category IN (...))
= Lucro Operacional (EBITDA simplificado)
```

---

## 3.3 Lógica de Entrada de Estoque

### Fluxo de criação de lote
1. Admin cria entrada via formulário de lote
2. Campos obrigatórios: `product_variation_id`, `entry_type`, `quantity`, `unit_cost`, `entry_date`
3. Campos opcionais: `freight_cost`, `tax_cost`, `supplier_id`, `notes`
4. `total_lot_cost` e `cost_per_unit` são gerados automaticamente (colunas GENERATED)
5. Trigger `trg_stock_lot_insert` atualiza `stock` table:
   - Se novo: INSERT com qty e avg_cost
   - Se existente: UPDATE com média ponderada do custo

### Cálculo do Custo Médio Ponderado (CMP)
```
novo_avg_cost = (qty_atual × avg_cost_atual + qty_nova × cost_per_unit_novo)
                / (qty_atual + qty_nova)
```
- Armazenado em `stock.avg_cost`
- Diferente do custo do lote (que é fixo por lote)
- O CMP é usado para relatórios de posição de estoque

### Produção Própria
- `entry_type = 'own_production'`
- `supplier_id = NULL`
- `unit_cost` = custo de produção informado manualmente
- Sem frete ou imposto de fornecedor (a menos que haja insumos)

---

## 3.4 Lógica de Saída de Estoque (FIFO)

### Ao registrar uma venda
1. Para cada `sale_item`, chamar `consume_stock_fifo(product_variation_id, quantity)`
2. A função retorna os lotes consumidos com `lot_id`, `consumed_qty` e `unit_cost`
3. `sale_items.stock_lot_id` recebe o lote mais recente (ou o único para qty unitária)
4. Para quantidades que atravessam lotes, o service layer cria múltiplos `sale_items` ou usa o custo médio ponderado

### Decisão de custo no sale_item
- **Opção A (recomendada para v1):** usar `stock.avg_cost` como `unit_cost`
  - Mais simples, menos sale_items
  - Pequena imprecisão no custo por lote
- **Opção B (precisão total):** criar um sale_item por lote consumido
  - Complexidade na UI (itens duplicados)
  - Maior precisão de margem realizada

> **Decisão:** usar Opção A (avg_cost) para v1. Migrar para Opção B se análise de margem por lote for necessária.

### Alerta de Estoque Mínimo
- Parâmetro: `parameters['stock_min_alert_qty']` (default: 3)
- Verificação: `stock.quantity <= alert_qty`
- Gerado no dashboard de estoque via query em `mv_stock_status`

---

## 3.5 Lógica de Devolução

### Devolução Total
1. Criar `returns` com `type = 'return'`
2. Criar `return_items` para cada `sale_item` (quantidade total)
3. Repor estoque: INSERT em `stock_lots` com `entry_type = 'purchase'`, `unit_cost = sale_item.unit_cost`, `quantity = return_quantity`
   - Trigger atualiza `stock` automaticamente
4. Atualizar `sales.status = 'returned'`
5. Criar `finance_entry` negativa (tipo `income`, valor negativo não é possível):
   - Criar entrada com `type = 'expense'`, `category = 'other_expense'`, referenciando o `return_id`
   - OU criar lançamento de estorno com `amount = total_refunded`
6. Reverter cashback: criar `cashback_transactions` com `type = 'reverse'`
   - Se cashback ainda `pending`: cancelar a transação original (status = 'reversed')
   - Se cashback `available` ou `used`: criar reverse proporcional
7. Atualizar `customer_metrics`: decrementar `total_spent` e `order_count`

### Devolução Parcial
- Criar `return_items` apenas para os itens devolvidos
- `returns.total_refunded` = SUM dos itens devolvidos
- Cashback revertido proporcionalmente: `reverse_amount = (total_devolvido / total_venda) × cashback_gerado`
- `sales.status` permanece como estava (não muda para 'returned' se parcial)

### Troca
1. Criar `returns` com `type = 'exchange'`
2. Repor itens trocados ao estoque (mesma lógica da devolução)
3. Criar nova venda OU adicionar novos itens à venda original (decisão de UX)
4. Se nova venda: valor = preço dos novos itens menos crédito dos itens trocados
5. Cashback: não reverter (a troca não é reembolso, é substituição)
6. Frete de troca: registrar como custo operacional

---

## 3.6 Lógica de Vendas Canceladas

1. `sales.status = 'cancelled'`
2. Reverter todos os `sale_items`:
   - Repor estoque via `stock_lots` insert
   - Atualizar `stock.quantity`
3. Reverter `finance_entries` relacionadas à venda
4. Reverter cashback gerado (status = 'reversed')
5. Decrementar `customer_metrics`
6. Não excluir o registro de venda — manter para auditoria e relatório de cancelamentos

### Relatório de Cancelamentos
- Query: `sales WHERE status = 'cancelled'`
- Campos: data, valor, motivo (campo `notes`), vendedor, cliente
- KPI no dashboard: `taxa_cancelamento = (cancelled / total) × 100`

---

## 3.7 Lógica de Cashback

### Parâmetros (configuráveis)
| Parâmetro             | Padrão | Onde         |
|-----------------------|--------|--------------|
| `cashback_rate`       | 5%     | `cashback_config.rate_pct` |
| `release_days`        | 30     | `cashback_config.release_days` |
| `expiry_days`         | 180    | `cashback_config.expiry_days` |
| `min_use_value`       | R$10   | `cashback_config.min_use_value` |
| `min_order_for_earn`  | R$0    | `cashback_config.min_order_value` |

### Geração (Earn)
```
base_value = sale.total - sale.discount_amount  // valor líquido após desconto
cashback_earn = base_value × (rate_pct / 100)
release_date = sale.sale_date + release_days
expiry_date  = release_date + expiry_days
```
- Criado quando `sale.status` muda para `'paid'`
- Status inicial: `'pending'`

### Liberação
- Job diário (`/api/jobs/cashback-release`)
- Query: `cashback_transactions WHERE status = 'pending' AND release_date <= CURRENT_DATE`
- UPDATE: `status = 'available'`

### Expiração
- Job diário
- Query: `cashback_transactions WHERE status = 'available' AND expiry_date <= CURRENT_DATE`
- UPDATE: `status = 'expired'`, criar transaction type `'expire'`

### Uso
```
1. Verificar: available_balance >= min_use_value
2. Verificar: cashback_used <= available_balance
3. Aplicar: sale.cashback_used = valor_usado
4. sale.total = subtotal - discount - cashback_used + shipping_charged
5. Criar cashback_transaction type='use', status='used'
6. Decrementar available_balance dos registros mais antigos (FIFO)
```

### Saldo do Cliente
```sql
-- View v_cashback_balance
pending_balance   = SUM WHERE type='earn' AND status='pending'
available_balance = SUM WHERE type='earn' AND status='available'
total_used        = SUM WHERE type='use'
total_expired     = SUM WHERE type='expire'
total_reversed    = SUM WHERE type='reverse'
```

### Reversão em Devolução
```
reverse_amount = (total_devolvido / total_venda_original) × cashback_gerado

Se cashback = 'pending':
  → UPDATE status='reversed'

Se cashback = 'available':
  → CREATE transaction type='reverse', amount=reverse_amount
  → available_balance -= reverse_amount

Se cashback já 'used':
  → Registrar reverse como crédito negativo (disponível para consulta)
  → Não reverter o que já foi usado (regra de negócio)
```

---

## 3.8 Lógica de RFM

### Definição dos Scores
- **R (Recency)**: dias desde a última compra. Score 1-5 onde 5 = comprou recentemente.
- **F (Frequency)**: total de compras. Score 1-5 onde 5 = mais compras.
- **M (Monetary)**: total gasto. Score 1-5 onde 5 = maior valor.

### Cálculo via NTILE
```sql
r_score = NTILE(5) OVER (ORDER BY days_since_last_purchase ASC)
f_score = NTILE(5) OVER (ORDER BY purchase_count DESC)
m_score = NTILE(5) OVER (ORDER BY total_spent DESC)
```
- `NTILE(5)` divide os clientes em 5 grupos iguais
- Recalculado diariamente na materialized view `mv_customer_rfm`

### Segmentos
| Segmento           | Critério                                          |
|--------------------|---------------------------------------------------|
| Champions          | R≥4, F≥4, M≥4                                    |
| Loyal              | F≥4, M≥3                                         |
| Potential Loyal    | R≥3, F≥2                                         |
| New Customers      | R≥4, F≤2                                         |
| Promising          | R=3, F≤2                                          |
| At Risk            | R≤2, F≥3, M≥3                                    |
| Can't Lose         | R≤2, F≥4, M≥4                                    |
| Hibernating        | R≤2, F≤2, M≤2                                    |
| Lost               | demais                                            |

### Sincronização com customer_metrics
- `customer_metrics.rfm_segment` é atualizado pelo job diário
- O score individual (r, f, m) também é armazenado em `customer_metrics`

---

## 3.9 Lógica da Curva ABC

### Algoritmo
1. Calcular métrica total de todos os produtos (faturamento, lucro ou volume)
2. Ordenar por métrica DESC
3. Calcular porcentagem acumulada
4. Classificar:
   - **A**: até 80% acumulado → produtos de alta relevância (~20% dos produtos)
   - **B**: de 80% a 95% → produtos de média relevância
   - **C**: acima de 95% → produtos de baixa relevância

### Três dimensões
| View                  | Métrica             | Uso                              |
|-----------------------|---------------------|----------------------------------|
| `mv_abc_by_revenue`   | `total_revenue`     | Quais produtos mais faturam      |
| `mv_abc_by_profit`    | `total_gross_profit`| Quais produtos mais lucram       |
| `mv_abc_by_volume`    | `total_units_sold`  | Quais produtos mais saem         |

### Aplicação prática
- Produtos ABC-A por faturamento mas ABC-C por lucro = alto giro, baixa margem → revisar precificação
- Produtos ABC-A por lucro mas ABC-C por volume = poucos clientes pagam caro → risco de concentração
- Cruzamento das 3 curvas revela estratégia de mix de produtos

---

## 3.10 Lógica de Relatórios

### Relatório de Giro de Estoque
```
giro = total_units_sold / avg_stock_quantity
avg_stock_quantity = (stock_inicial + stock_final) / 2

dias_médios_para_vender = 365 / giro
```
- Calculado por produto e categoria
- Período: 30, 90, 365 dias (parâmetro da query)

### CAC (Custo de Aquisição de Cliente)
```
novos_clientes_no_período = COUNT(customers WHERE created_at BETWEEN start AND end)
investimento_marketing = SUM(marketing_costs WHERE cost_date BETWEEN start AND end)

CAC = investimento_marketing / novos_clientes_no_período
```

### ROI de Marketing
```
ROI = ((receita_atribuída - custo_marketing) / custo_marketing) × 100
```
- `receita_atribuída` = vendas com `sale_origin` ligado à campanha
- Calculado por canal e por campanha

### ROAS (Return on Ad Spend)
```
ROAS = receita_atribuída / custo_campanha
```
- Apenas para campanhas com canal de tráfego pago

### Fluxo de Caixa
```
Entradas: SUM(finance_entries WHERE type='income' AND reference_date = período)
Saídas:   SUM(finance_entries WHERE type='expense' AND reference_date = período)
Saldo:    entradas - saídas
```

---

## 3.11 Lógica dos Dashboards

### Dashboard Geral
Dados em tempo real (últimas 24h) e comparativo com período anterior:
- Faturamento do dia / semana / mês
- Número de vendas
- Ticket médio
- Margem bruta média
- Top 5 produtos vendidos
- Alertas de estoque mínimo
- Cashback a liberar

### Dashboard de Vendas
Fonte: `mv_daily_sales_summary` + queries ad-hoc por filtro de período
- Faturamento por período (linha)
- Vendas por canal de origem (pizza)
- Vendas por forma de pagamento (barra)
- Vendas por vendedor
- Taxa de cancelamento

### Dashboard de Estoque
Fonte: `mv_stock_status`
- Posição atual: qty, valor a custo, valor a preço
- Produtos abaixo do mínimo (alerta)
- Produtos sem movimentação (> 30/60/90 dias)
- Distribuição por categoria
- Valor total imobilizado

### Dashboard de Margem e Lucro
Fonte: `mv_product_performance` + `mv_monthly_financial`
- Margem média realizada vs. planejada
- Top 10 produtos por margem
- Bottom 10 produtos por margem
- Lucro bruto por categoria
- Evolução do lucro mensal

### Dashboard de Clientes
Fonte: `mv_customer_rfm` + `customer_metrics`
- Distribuição por segmento RFM (mapa de calor)
- Total de clientes ativos
- Clientes por origem
- Ticket médio por segmento
- Clientes em risco (At Risk + Cant Lose)

### Dashboard de Marketing
Fonte: `marketing_costs` + `campaigns`
- Custo total por categoria (pizza)
- Evolução mensal de investimento
- CAC mensal
- ROI por canal
- Campanhas ativas com status de budget

### Dashboard Financeiro
Fonte: `mv_monthly_financial`
- DRE simplificado do mês
- Fluxo de caixa (entradas vs. saídas por semana)
- Comparativo mensal (receita, CMV, lucro)
- Principais despesas do período

### Dashboard de Cashback
Fonte: `v_cashback_balance` + `cashback_transactions`
- Total de saldo pendente (aguardando liberação)
- Total de saldo disponível
- Total utilizado no período
- Total expirado (dinheiro "salvo")
- Top clientes com maior saldo

### Dashboard de Inteligência de Produto
Fonte: `mv_product_performance` + `mv_abc_*` + `mv_color_performance`
- Curva ABC interativa (revenue / profit / volume)
- Performance por cor: faturamento, volume, ticket médio
- Produtos parados (sem venda > 30 dias)
- Fornecedor mais relevante por margem / giro / volume

### Dashboard de Giro de Estoque
Fonte: `mv_stock_status` + `mv_product_performance`
- Giro por produto e categoria
- Dias médios para vender
- Categorias mais paradas
- Fornecedores com produtos mais parados
- Estoque imobilizado × giro

---

## 3.12 Regras de Validação de Domínio

### CPF
```typescript
// Algoritmo de validação do dígito verificador
function validateCPF(cpf: string): boolean {
  cpf = cpf.replace(/\D/g, '')
  if (cpf.length !== 11) return false
  if (/^(\d)\1{10}$/.test(cpf)) return false  // todos iguais

  // Primeiro dígito verificador
  let sum = 0
  for (let i = 0; i < 9; i++) sum += parseInt(cpf[i]) * (10 - i)
  let rest = (sum * 10) % 11
  if (rest === 10 || rest === 11) rest = 0
  if (rest !== parseInt(cpf[9])) return false

  // Segundo dígito verificador
  sum = 0
  for (let i = 0; i < 10; i++) sum += parseInt(cpf[i]) * (11 - i)
  rest = (sum * 10) % 11
  if (rest === 10 || rest === 11) rest = 0
  return rest === parseInt(cpf[10])
}
```

### Regra: não vender sem cadastro completo
- Campos obrigatórios para completar venda: `cpf`, `name`, `phone`
- Validado no frontend antes do submit
- Validado no backend via zod schema

### Cálculo do total da venda
```
subtotal      = SUM(sale_items: unit_price × quantity - discount_item)
total         = subtotal - discount_amount - cashback_used + shipping_charged
```
- Validação: `total >= 0` (constraint no banco)
- Validação: `cashback_used <= available_balance` (validado no service)

### Sale Number
```
SNT-YYYYMMDD-NNNN
Exemplo: SNT-20260315-0001
```
- Sequencial por dia
- Gerado pela função `generate_sale_number()`
