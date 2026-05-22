-- =============================================================================
-- Validação pós-migration: rpc_create_sale com p_payments
--
-- Execute cada bloco SEPARADAMENTE no SQL Editor do Supabase.
-- Todos os testes usam BEGIN/ROLLBACK — nenhum dado permanece no banco.
--
-- Substitua antes de rodar:
--   :seller_id     → um UUID válido de users (vendedor ativo)
--   :customer_id   → um INT válido de customers
--   :pvid          → um INT válido de product_variations com estoque > 0
--   :unit_cost     → o avg_cost da variação acima
-- =============================================================================

-- ─── Buscar valores reais para usar nos testes ────────────────────────────────
-- Rode primeiro para pegar os valores de substituição acima:

SELECT
  u.id            AS seller_id,
  u.company_id,
  c.id            AS customer_id,
  pv.id           AS pvid,
  s.quantity      AS estoque_disponivel,
  s.avg_cost      AS unit_cost
FROM users u
JOIN customers c ON c.company_id = u.company_id
JOIN product_variations pv ON pv.id IN (
  SELECT product_variation_id FROM stock WHERE quantity > 0 LIMIT 1
)
JOIN stock s ON s.product_variation_id = pv.id
WHERE u.role IN ('admin', 'seller')
LIMIT 1;

-- =============================================================================
-- TESTE 1 — Path legado (p_payments = NULL)
-- Comportamento 100% idêntico ao original.
-- Esperado: sale criada, 1 linha em sale_payments, finance_entry de receita.
-- =============================================================================
BEGIN;

SELECT public.rpc_create_sale(
  p_customer_id    := :customer_id,
  p_seller_id      := ':seller_id'::uuid,
  p_payment_method := 'pix',
  p_sale_origin    := NULL,
  p_discount_amount:= 0,
  p_cashback_used  := 0,
  p_shipping_charged:= 0,
  p_notes          := 'TESTE 1 — legado',
  p_items          := jsonb_build_array(jsonb_build_object(
    'product_variation_id', :pvid,
    'quantity',             1,
    'unit_price',           100.00,
    'unit_cost',            :unit_cost,
    'discount_amount',      0
  )),
  p_system_user_id := ':seller_id'::uuid,
  p_card_fee       := 0,
  p_surcharge_amount:= 0,
  p_payments       := NULL
) AS resultado;

-- Verificar: 1 linha em sale_payments, method = pix, net_amount = 100
SELECT sp.method, sp.amount_tendered, sp.change_amount, sp.net_amount,
       sp.fee_percentage, sp.fee_amount
FROM sale_payments sp
JOIN sales s ON s.id = sp.sale_id
ORDER BY sp.created_at DESC LIMIT 1;

ROLLBACK;

-- =============================================================================
-- TESTE 2 — Pix + Dinheiro (dois pagamentos, sem troco)
-- Venda de R$150: Pix R$80 + Dinheiro R$70
-- Esperado: sale criada com payment_method = 'pix' (dominante),
--           2 linhas em sale_payments.
-- =============================================================================
BEGIN;

SELECT public.rpc_create_sale(
  p_customer_id    := :customer_id,
  p_seller_id      := ':seller_id'::uuid,
  p_payment_method := 'pix',      -- ignorado pelo RPC quando p_payments != NULL
  p_sale_origin    := NULL,
  p_discount_amount:= 0,
  p_cashback_used  := 0,
  p_shipping_charged:= 0,
  p_notes          := 'TESTE 2 — Pix + Dinheiro',
  p_items          := jsonb_build_array(jsonb_build_object(
    'product_variation_id', :pvid,
    'quantity',             1,
    'unit_price',           150.00,
    'unit_cost',            :unit_cost,
    'discount_amount',      0
  )),
  p_system_user_id := ':seller_id'::uuid,
  p_card_fee       := 0,
  p_surcharge_amount:= 0,
  p_payments       := '[
    {
      "method":          "pix",
      "amount_tendered": 80.00,
      "change_amount":   0,
      "net_amount":      80.00
    },
    {
      "method":          "cash",
      "amount_tendered": 70.00,
      "change_amount":   0,
      "net_amount":      70.00
    }
  ]'::jsonb
) AS resultado;

-- Verificar: payment_method = pix (dominante), 2 linhas em sale_payments
SELECT s.payment_method AS dominante,
       sp.method, sp.net_amount
FROM sales s
JOIN sale_payments sp ON sp.sale_id = s.id
ORDER BY s.created_at DESC, sp.net_amount DESC;

ROLLBACK;

-- =============================================================================
-- TESTE 3 — Dinheiro com troco via Pix
-- Venda R$80: cliente paga R$100 em dinheiro, troco R$20 via Pix
-- Esperado: 1 linha em sale_payments com change_amount=20, change_method='pix'
-- =============================================================================
BEGIN;

SELECT public.rpc_create_sale(
  p_customer_id    := :customer_id,
  p_seller_id      := ':seller_id'::uuid,
  p_payment_method := 'cash',
  p_sale_origin    := NULL,
  p_discount_amount:= 0,
  p_cashback_used  := 0,
  p_shipping_charged:= 0,
  p_notes          := 'TESTE 3 — Dinheiro troco Pix',
  p_items          := jsonb_build_array(jsonb_build_object(
    'product_variation_id', :pvid,
    'quantity',             1,
    'unit_price',           80.00,
    'unit_cost',            :unit_cost,
    'discount_amount',      0
  )),
  p_system_user_id := ':seller_id'::uuid,
  p_payments       := '[
    {
      "method":          "cash",
      "amount_tendered": 100.00,
      "change_amount":   20.00,
      "change_method":   "pix",
      "net_amount":      80.00
    }
  ]'::jsonb
) AS resultado;

SELECT sp.method, sp.amount_tendered, sp.change_amount,
       sp.change_method, sp.net_amount
FROM sale_payments sp
ORDER BY sp.created_at DESC LIMIT 1;
-- Esperado: cash | 100 | 20 | pix | 80

ROLLBACK;

-- =============================================================================
-- TESTE 4 — Crédito parcelado + Pix
-- Venda R$300: Crédito 3x R$200 + Pix R$100
-- Esperado: payment_method = 'credit_card' (dominante),
--           fee_amount calculado para o crédito, finance_entry de taxa criada
-- =============================================================================
BEGIN;

SELECT public.rpc_create_sale(
  p_customer_id    := :customer_id,
  p_seller_id      := ':seller_id'::uuid,
  p_payment_method := 'pix',
  p_sale_origin    := NULL,
  p_discount_amount:= 0,
  p_cashback_used  := 0,
  p_shipping_charged:= 0,
  p_notes          := 'TESTE 4 — Crédito 3x + Pix',
  p_items          := jsonb_build_array(jsonb_build_object(
    'product_variation_id', :pvid,
    'quantity',             1,
    'unit_price',           300.00,
    'unit_cost',            :unit_cost,
    'discount_amount',      0
  )),
  p_system_user_id := ':seller_id'::uuid,
  p_payments       := '[
    {
      "method":          "credit_card",
      "amount_tendered": 200.00,
      "change_amount":   0,
      "net_amount":      200.00,
      "installments":    3,
      "card_brand":      "visa",
      "acquirer":        "stone"
    },
    {
      "method":          "pix",
      "amount_tendered": 100.00,
      "change_amount":   0,
      "net_amount":      100.00
    }
  ]'::jsonb
) AS resultado;

-- Verificar dominante e pagamentos
SELECT s.payment_method AS dominante, s.total
FROM sales s ORDER BY s.created_at DESC LIMIT 1;
-- Esperado: credit_card | 300.00

SELECT sp.method, sp.net_amount, sp.installments,
       sp.fee_percentage, sp.fee_amount, sp.card_brand
FROM sale_payments sp
ORDER BY sp.created_at DESC, sp.net_amount DESC;
-- Esperado: credit_card 3x com fee_amount calculado, pix sem taxa

-- Verificar finance_entry de taxa
SELECT fe.type, fe.category, fe.description, fe.amount
FROM finance_entries fe
ORDER BY fe.created_at DESC LIMIT 3;
-- Esperado: despesa de taxa de cartão (se fee > 0 em payment_fee_settings)

ROLLBACK;

-- =============================================================================
-- TESTE 5 — Falha: pagamento incompleto (SUM(net_amount) < total)
-- Esperado: EXCEPTION "Soma dos pagamentos ... difere do total"
-- =============================================================================
BEGIN;

SELECT public.rpc_create_sale(
  p_customer_id    := :customer_id,
  p_seller_id      := ':seller_id'::uuid,
  p_payment_method := 'pix',
  p_sale_origin    := NULL,
  p_discount_amount:= 0,
  p_cashback_used  := 0,
  p_shipping_charged:= 0,
  p_notes          := 'TESTE 5 — deve falhar',
  p_items          := jsonb_build_array(jsonb_build_object(
    'product_variation_id', :pvid,
    'quantity',             1,
    'unit_price',           200.00,
    'unit_cost',            :unit_cost,
    'discount_amount',      0
  )),
  p_system_user_id := ':seller_id'::uuid,
  p_payments       := '[
    {
      "method":          "pix",
      "amount_tendered": 100.00,
      "change_amount":   0,
      "net_amount":      100.00
    }
  ]'::jsonb
) AS resultado;
-- Esperado: ERROR P0001 — Soma dos pagamentos (100) difere do total (200).

ROLLBACK;

-- =============================================================================
-- TESTE 6 — Falha: net_amount acima do total sem troco (excesso em net_amount)
-- Esperado: EXCEPTION "Soma dos pagamentos ... difere do total"
-- Correto seria: amount_tendered=250, change_amount=50, net_amount=200
-- =============================================================================
BEGIN;

SELECT public.rpc_create_sale(
  p_customer_id    := :customer_id,
  p_seller_id      := ':seller_id'::uuid,
  p_payment_method := 'cash',
  p_sale_origin    := NULL,
  p_discount_amount:= 0,
  p_cashback_used  := 0,
  p_shipping_charged:= 0,
  p_notes          := 'TESTE 6 — deve falhar',
  p_items          := jsonb_build_array(jsonb_build_object(
    'product_variation_id', :pvid,
    'quantity',             1,
    'unit_price',           200.00,
    'unit_cost',            :unit_cost,
    'discount_amount',      0
  )),
  p_system_user_id := ':seller_id'::uuid,
  p_payments       := '[
    {
      "method":          "cash",
      "amount_tendered": 250.00,
      "change_amount":   0,
      "net_amount":      250.00
    }
  ]'::jsonb
) AS resultado;
-- Esperado: ERROR P0001 — Soma dos pagamentos (250) difere do total (200).
-- O excesso deve ser troco: amount_tendered=250, change_amount=50, net_amount=200

ROLLBACK;

-- =============================================================================
-- Se todos os testes passaram:
--   TESTE 1: venda legada criada, 1 linha em sale_payments ✓
--   TESTE 2: 2 pagamentos, dominante correto ✓
--   TESTE 3: troco em Pix registrado corretamente ✓
--   TESTE 4: taxa de cartão calculada, finance_entry criada ✓
--   TESTE 5: bloqueado por soma incorreta ✓
--   TESTE 6: bloqueado por net_amount acima do total ✓
--   → Pode prosseguir para alteração do frontend
-- =============================================================================
