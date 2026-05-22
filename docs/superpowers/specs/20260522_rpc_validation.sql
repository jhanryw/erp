-- =============================================================================
-- Validação pós-migration: rpc_create_sale com p_payments
--
-- Não requer substituição manual. Todos os valores (seller, customer,
-- product_variation, unit_cost) são buscados dinamicamente do banco via
-- subqueries inline.
--
-- Execute cada bloco BEGIN/ROLLBACK SEPARADAMENTE no SQL Editor.
-- Nenhum dado permanece no banco após os testes.
-- =============================================================================

-- =============================================================================
-- PASSO 0 — Verificar que existe dados suficientes para os testes
-- Esperado: 1 linha com todos os campos preenchidos
-- =============================================================================
SELECT
  u.id            AS seller_id,
  c.id            AS customer_id,
  pv.id           AS pvid,
  s.quantity      AS estoque,
  s.avg_cost      AS unit_cost,
  p.company_id
FROM users u
JOIN customers      c  ON c.company_id  = u.company_id
JOIN products       p  ON p.company_id  = u.company_id
JOIN product_variations pv ON pv.product_id = p.id
JOIN stock          s  ON s.product_variation_id = pv.id
WHERE u.role IN ('admin', 'seller')
  AND s.quantity > 0
LIMIT 1;
-- Se não retornar linha: não há estoque disponível para testar.

-- =============================================================================
-- TESTE 1 — Path legado (p_payments = NULL)
-- Venda R$100 via Pix, caminho original sem alteração.
-- Esperado: sale criada com payment_method='pix',
--           1 linha em sale_payments (inserida pelo path legado).
-- =============================================================================
BEGIN;

SELECT public.rpc_create_sale(
  p_customer_id     := (
    SELECT c.id FROM customers c
    JOIN users u ON u.company_id = c.company_id
    WHERE u.role IN ('admin','seller') LIMIT 1
  ),
  p_seller_id       := (
    SELECT id FROM users WHERE role IN ('admin','seller') LIMIT 1
  ),
  p_payment_method  := 'pix'::payment_method,
  p_sale_origin     := NULL,
  p_discount_amount := 0,
  p_cashback_used   := 0,
  p_shipping_charged:= 0,
  p_notes           := 'TESTE 1 — legado sem p_payments',
  p_items           := (
    SELECT jsonb_build_array(jsonb_build_object(
      'product_variation_id', pv.id,
      'quantity',             1,
      'unit_price',           100.00,
      'unit_cost',            s.avg_cost,
      'discount_amount',      0
    ))
    FROM stock s
    JOIN product_variations pv ON pv.id = s.product_variation_id
    JOIN products p ON p.id = pv.product_id
    JOIN users u ON u.company_id = p.company_id
    WHERE u.role IN ('admin','seller') AND s.quantity > 0
    LIMIT 1
  ),
  p_system_user_id  := (
    SELECT id FROM users WHERE role IN ('admin','seller') LIMIT 1
  ),
  p_card_fee        := 0,
  p_surcharge_amount:= 0,
  p_payments        := NULL
) AS resultado;

-- Verificar: 1 linha em sale_payments, method=pix, net_amount=100
SELECT sp.method, sp.amount_tendered, sp.change_amount,
       sp.net_amount, sp.fee_amount
FROM sale_payments sp
ORDER BY sp.created_at DESC LIMIT 1;

ROLLBACK;

-- =============================================================================
-- TESTE 2 — Pix R$80 + Dinheiro R$70 (venda R$150, sem troco)
-- Esperado: payment_method='pix' (dominante por maior net_amount),
--           2 linhas em sale_payments.
-- =============================================================================
BEGIN;

SELECT public.rpc_create_sale(
  p_customer_id     := (
    SELECT c.id FROM customers c
    JOIN users u ON u.company_id = c.company_id
    WHERE u.role IN ('admin','seller') LIMIT 1
  ),
  p_seller_id       := (
    SELECT id FROM users WHERE role IN ('admin','seller') LIMIT 1
  ),
  p_payment_method  := 'pix'::payment_method,
  p_sale_origin     := NULL,
  p_discount_amount := 0,
  p_cashback_used   := 0,
  p_shipping_charged:= 0,
  p_notes           := 'TESTE 2 — Pix + Dinheiro',
  p_items           := (
    SELECT jsonb_build_array(jsonb_build_object(
      'product_variation_id', pv.id,
      'quantity',             1,
      'unit_price',           150.00,
      'unit_cost',            s.avg_cost,
      'discount_amount',      0
    ))
    FROM stock s
    JOIN product_variations pv ON pv.id = s.product_variation_id
    JOIN products p ON p.id = pv.product_id
    JOIN users u ON u.company_id = p.company_id
    WHERE u.role IN ('admin','seller') AND s.quantity > 0
    LIMIT 1
  ),
  p_system_user_id  := (
    SELECT id FROM users WHERE role IN ('admin','seller') LIMIT 1
  ),
  p_payments        := '[
    {"method":"pix",  "amount_tendered":80.00,"change_amount":0,"net_amount":80.00},
    {"method":"cash", "amount_tendered":70.00,"change_amount":0,"net_amount":70.00}
  ]'::jsonb
) AS resultado;

-- Verificar dominante e os dois pagamentos
SELECT s.payment_method AS dominante, s.total
FROM sales s ORDER BY s.created_at DESC LIMIT 1;
-- Esperado: pix | 150.00

SELECT sp.method, sp.net_amount
FROM sale_payments sp
JOIN sales s ON s.id = sp.sale_id
ORDER BY s.created_at DESC, sp.net_amount DESC;
-- Esperado: 2 linhas — pix 80 e cash 70

ROLLBACK;

-- =============================================================================
-- TESTE 3 — Dinheiro R$100 com troco R$20 via Pix (venda R$80)
-- Esperado: 1 linha em sale_payments com change_amount=20, change_method='pix',
--           net_amount=80, amount_tendered=100.
-- =============================================================================
BEGIN;

SELECT public.rpc_create_sale(
  p_customer_id     := (
    SELECT c.id FROM customers c
    JOIN users u ON u.company_id = c.company_id
    WHERE u.role IN ('admin','seller') LIMIT 1
  ),
  p_seller_id       := (
    SELECT id FROM users WHERE role IN ('admin','seller') LIMIT 1
  ),
  p_payment_method  := 'cash'::payment_method,
  p_sale_origin     := NULL,
  p_discount_amount := 0,
  p_cashback_used   := 0,
  p_shipping_charged:= 0,
  p_notes           := 'TESTE 3 — Dinheiro troco Pix',
  p_items           := (
    SELECT jsonb_build_array(jsonb_build_object(
      'product_variation_id', pv.id,
      'quantity',             1,
      'unit_price',           80.00,
      'unit_cost',            s.avg_cost,
      'discount_amount',      0
    ))
    FROM stock s
    JOIN product_variations pv ON pv.id = s.product_variation_id
    JOIN products p ON p.id = pv.product_id
    JOIN users u ON u.company_id = p.company_id
    WHERE u.role IN ('admin','seller') AND s.quantity > 0
    LIMIT 1
  ),
  p_system_user_id  := (
    SELECT id FROM users WHERE role IN ('admin','seller') LIMIT 1
  ),
  p_payments        := '[
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
FROM sale_payments sp ORDER BY sp.created_at DESC LIMIT 1;
-- Esperado: cash | 100 | 20 | pix | 80

ROLLBACK;

-- =============================================================================
-- TESTE 4 — Crédito 3x R$200 + Pix R$100 (venda R$300)
-- Esperado: payment_method='credit_card' (dominante),
--           fee_amount calculado para o crédito (se houver taxa configurada),
--           finance_entry de despesa criada para a taxa.
-- =============================================================================
BEGIN;

SELECT public.rpc_create_sale(
  p_customer_id     := (
    SELECT c.id FROM customers c
    JOIN users u ON u.company_id = c.company_id
    WHERE u.role IN ('admin','seller') LIMIT 1
  ),
  p_seller_id       := (
    SELECT id FROM users WHERE role IN ('admin','seller') LIMIT 1
  ),
  p_payment_method  := 'pix'::payment_method,
  p_sale_origin     := NULL,
  p_discount_amount := 0,
  p_cashback_used   := 0,
  p_shipping_charged:= 0,
  p_notes           := 'TESTE 4 — Credito 3x + Pix',
  p_items           := (
    SELECT jsonb_build_array(jsonb_build_object(
      'product_variation_id', pv.id,
      'quantity',             1,
      'unit_price',           300.00,
      'unit_cost',            s.avg_cost,
      'discount_amount',      0
    ))
    FROM stock s
    JOIN product_variations pv ON pv.id = s.product_variation_id
    JOIN products p ON p.id = pv.product_id
    JOIN users u ON u.company_id = p.company_id
    WHERE u.role IN ('admin','seller') AND s.quantity > 0
    LIMIT 1
  ),
  p_system_user_id  := (
    SELECT id FROM users WHERE role IN ('admin','seller') LIMIT 1
  ),
  p_payments        := '[
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

-- Dominante e total
SELECT s.payment_method AS dominante, s.total
FROM sales s ORDER BY s.created_at DESC LIMIT 1;
-- Esperado: credit_card | 300.00

-- Pagamentos com taxa
SELECT sp.method, sp.net_amount, sp.installments,
       sp.fee_percentage, sp.fee_amount, sp.card_brand
FROM sale_payments sp
JOIN sales s ON s.id = sp.sale_id
ORDER BY s.created_at DESC, sp.net_amount DESC;
-- Esperado: credit_card 3x com fee calculado | pix sem taxa

-- Finance entries da venda (receita + possível taxa de cartão)
SELECT fe.type, fe.category, fe.description, fe.amount
FROM finance_entries fe
ORDER BY fe.created_at DESC LIMIT 3;

ROLLBACK;

-- =============================================================================
-- TESTE 5 — DEVE FALHAR: pagamento incompleto (soma < total)
-- Venda R$200, pagamento R$100 apenas.
-- Esperado: ERROR P0001 — "Soma dos pagamentos (100.00) difere do total (200.00)"
-- =============================================================================
BEGIN;

SELECT public.rpc_create_sale(
  p_customer_id     := (
    SELECT c.id FROM customers c
    JOIN users u ON u.company_id = c.company_id
    WHERE u.role IN ('admin','seller') LIMIT 1
  ),
  p_seller_id       := (
    SELECT id FROM users WHERE role IN ('admin','seller') LIMIT 1
  ),
  p_payment_method  := 'pix'::payment_method,
  p_sale_origin     := NULL,
  p_discount_amount := 0,
  p_cashback_used   := 0,
  p_shipping_charged:= 0,
  p_notes           := 'TESTE 5 — deve falhar',
  p_items           := (
    SELECT jsonb_build_array(jsonb_build_object(
      'product_variation_id', pv.id,
      'quantity',             1,
      'unit_price',           200.00,
      'unit_cost',            s.avg_cost,
      'discount_amount',      0
    ))
    FROM stock s
    JOIN product_variations pv ON pv.id = s.product_variation_id
    JOIN products p ON p.id = pv.product_id
    JOIN users u ON u.company_id = p.company_id
    WHERE u.role IN ('admin','seller') AND s.quantity > 0
    LIMIT 1
  ),
  p_system_user_id  := (
    SELECT id FROM users WHERE role IN ('admin','seller') LIMIT 1
  ),
  p_payments        := '[
    {"method":"pix","amount_tendered":100.00,"change_amount":0,"net_amount":100.00}
  ]'::jsonb
) AS resultado;

ROLLBACK;

-- =============================================================================
-- TESTE 6 — DEVE FALHAR: net_amount acima do total sem troco declarado
-- Venda R$200, net_amount=250 (excesso não declarado como troco).
-- Esperado: ERROR P0001 — "Soma dos pagamentos (250.00) difere do total (200.00)"
-- Correto seria: amount_tendered=250, change_amount=50, net_amount=200
-- =============================================================================
BEGIN;

SELECT public.rpc_create_sale(
  p_customer_id     := (
    SELECT c.id FROM customers c
    JOIN users u ON u.company_id = c.company_id
    WHERE u.role IN ('admin','seller') LIMIT 1
  ),
  p_seller_id       := (
    SELECT id FROM users WHERE role IN ('admin','seller') LIMIT 1
  ),
  p_payment_method  := 'cash'::payment_method,
  p_sale_origin     := NULL,
  p_discount_amount := 0,
  p_cashback_used   := 0,
  p_shipping_charged:= 0,
  p_notes           := 'TESTE 6 — deve falhar',
  p_items           := (
    SELECT jsonb_build_array(jsonb_build_object(
      'product_variation_id', pv.id,
      'quantity',             1,
      'unit_price',           200.00,
      'unit_cost',            s.avg_cost,
      'discount_amount',      0
    ))
    FROM stock s
    JOIN product_variations pv ON pv.id = s.product_variation_id
    JOIN products p ON p.id = pv.product_id
    JOIN users u ON u.company_id = p.company_id
    WHERE u.role IN ('admin','seller') AND s.quantity > 0
    LIMIT 1
  ),
  p_system_user_id  := (
    SELECT id FROM users WHERE role IN ('admin','seller') LIMIT 1
  ),
  p_payments        := '[
    {"method":"cash","amount_tendered":250.00,"change_amount":0,"net_amount":250.00}
  ]'::jsonb
) AS resultado;

ROLLBACK;

-- =============================================================================
-- Se os testes passaram:
--   TESTE 1 ✓ — legado: 1 linha em sale_payments, comportamento inalterado
--   TESTE 2 ✓ — 2 pagamentos, dominante = pix
--   TESTE 3 ✓ — troco via Pix registrado corretamente
--   TESTE 4 ✓ — taxa de cartão calculada, finance_entry criada
--   TESTE 5 ✓ — bloqueado por soma abaixo do total
--   TESTE 6 ✓ — bloqueado por net_amount acima do total
-- → Pode prosseguir para alteração do frontend
-- =============================================================================
