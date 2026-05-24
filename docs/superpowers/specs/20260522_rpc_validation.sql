-- =============================================================================
-- Validação pós-migration: rpc_create_sale com p_payments
-- Todos os blocos abaixo devem completar SEM ERRO.
-- Execute cada BEGIN/ROLLBACK separadamente no SQL Editor.
-- =============================================================================

-- PASSO 0 — Confirmar dados disponíveis (deve retornar 1 linha)
SELECT
  u.id       AS seller_id,
  c.id       AS customer_id,
  pv.id      AS pvid,
  s.quantity AS estoque,
  s.avg_cost AS unit_cost
FROM users u
JOIN customers          c  ON c.company_id        = u.company_id
JOIN products           p  ON p.company_id         = u.company_id
JOIN product_variations pv ON pv.product_id        = p.id
JOIN stock              s  ON s.product_variation_id = pv.id
WHERE u.role IN ('admin', 'seller') AND s.quantity > 0
LIMIT 1;

-- =============================================================================
-- TESTE 1 — Path legado (p_payments = NULL)
-- Esperado: resultado com id/sale_number + 1 linha em sale_payments
-- =============================================================================
BEGIN;

SELECT public.rpc_create_sale(
  p_customer_id      := (SELECT c.id FROM customers c JOIN users u ON u.company_id = c.company_id WHERE u.role IN ('admin','seller') LIMIT 1),
  p_seller_id        := (SELECT id FROM users WHERE role IN ('admin','seller') LIMIT 1),
  p_payment_method   := 'pix'::payment_method,
  p_sale_origin      := NULL,
  p_discount_amount  := 0,
  p_cashback_used    := 0,
  p_shipping_charged := 0,
  p_notes            := 'TESTE 1 — legado',
  p_items            := (SELECT jsonb_build_array(jsonb_build_object('product_variation_id', pv.id, 'quantity', 1, 'unit_price', 100.00, 'unit_cost', s.avg_cost, 'discount_amount', 0)) FROM stock s JOIN product_variations pv ON pv.id = s.product_variation_id JOIN products p ON p.id = pv.product_id JOIN users u ON u.company_id = p.company_id WHERE u.role IN ('admin','seller') AND s.quantity > 0 LIMIT 1),
  p_system_user_id   := (SELECT id FROM users WHERE role IN ('admin','seller') LIMIT 1),
  p_card_fee         := 0,
  p_surcharge_amount := 0,
  p_payments         := NULL
) AS resultado;

SELECT sp.method, sp.amount_tendered, sp.net_amount, sp.fee_amount
FROM sale_payments sp ORDER BY sp.created_at DESC LIMIT 1;

ROLLBACK;

-- =============================================================================
-- TESTE 2 — Pix R$80 + Dinheiro R$70 (venda R$150)
-- Esperado: dominante=pix, 2 linhas em sale_payments
-- =============================================================================
BEGIN;

SELECT public.rpc_create_sale(
  p_customer_id      := (SELECT c.id FROM customers c JOIN users u ON u.company_id = c.company_id WHERE u.role IN ('admin','seller') LIMIT 1),
  p_seller_id        := (SELECT id FROM users WHERE role IN ('admin','seller') LIMIT 1),
  p_payment_method   := 'pix'::payment_method,
  p_sale_origin      := NULL,
  p_discount_amount  := 0,
  p_cashback_used    := 0,
  p_shipping_charged := 0,
  p_notes            := 'TESTE 2 — Pix + Dinheiro',
  p_items            := (SELECT jsonb_build_array(jsonb_build_object('product_variation_id', pv.id, 'quantity', 1, 'unit_price', 150.00, 'unit_cost', s.avg_cost, 'discount_amount', 0)) FROM stock s JOIN product_variations pv ON pv.id = s.product_variation_id JOIN products p ON p.id = pv.product_id JOIN users u ON u.company_id = p.company_id WHERE u.role IN ('admin','seller') AND s.quantity > 0 LIMIT 1),
  p_system_user_id   := (SELECT id FROM users WHERE role IN ('admin','seller') LIMIT 1),
  p_payments         := '[{"method":"pix","amount_tendered":80.00,"change_amount":0,"net_amount":80.00},{"method":"cash","amount_tendered":70.00,"change_amount":0,"net_amount":70.00}]'::jsonb
) AS resultado;

SELECT s.payment_method AS dominante, s.total FROM sales s ORDER BY s.created_at DESC LIMIT 1;
SELECT sp.method, sp.net_amount FROM sale_payments sp JOIN sales s ON s.id = sp.sale_id ORDER BY s.created_at DESC, sp.net_amount DESC;

ROLLBACK;

-- =============================================================================
-- TESTE 3 — Dinheiro R$100, troco R$20 via Pix (venda R$80)
-- Esperado: cash | 100 | 20 | pix | 80
-- =============================================================================
BEGIN;

SELECT public.rpc_create_sale(
  p_customer_id      := (SELECT c.id FROM customers c JOIN users u ON u.company_id = c.company_id WHERE u.role IN ('admin','seller') LIMIT 1),
  p_seller_id        := (SELECT id FROM users WHERE role IN ('admin','seller') LIMIT 1),
  p_payment_method   := 'cash'::payment_method,
  p_sale_origin      := NULL,
  p_discount_amount  := 0,
  p_cashback_used    := 0,
  p_shipping_charged := 0,
  p_notes            := 'TESTE 3 — Dinheiro troco Pix',
  p_items            := (SELECT jsonb_build_array(jsonb_build_object('product_variation_id', pv.id, 'quantity', 1, 'unit_price', 80.00, 'unit_cost', s.avg_cost, 'discount_amount', 0)) FROM stock s JOIN product_variations pv ON pv.id = s.product_variation_id JOIN products p ON p.id = pv.product_id JOIN users u ON u.company_id = p.company_id WHERE u.role IN ('admin','seller') AND s.quantity > 0 LIMIT 1),
  p_system_user_id   := (SELECT id FROM users WHERE role IN ('admin','seller') LIMIT 1),
  p_payments         := '[{"method":"cash","amount_tendered":100.00,"change_amount":20.00,"change_method":"pix","net_amount":80.00}]'::jsonb
) AS resultado;

SELECT sp.method, sp.amount_tendered, sp.change_amount, sp.change_method, sp.net_amount
FROM sale_payments sp ORDER BY sp.created_at DESC LIMIT 1;

ROLLBACK;

-- =============================================================================
-- TESTE 4 — Crédito 3x R$200 + Pix R$100 (venda R$300)
-- Esperado: dominante=credit_card, fee_amount calculado, finance_entry de taxa
-- =============================================================================
BEGIN;

SELECT public.rpc_create_sale(
  p_customer_id      := (SELECT c.id FROM customers c JOIN users u ON u.company_id = c.company_id WHERE u.role IN ('admin','seller') LIMIT 1),
  p_seller_id        := (SELECT id FROM users WHERE role IN ('admin','seller') LIMIT 1),
  p_payment_method   := 'pix'::payment_method,
  p_sale_origin      := NULL,
  p_discount_amount  := 0,
  p_cashback_used    := 0,
  p_shipping_charged := 0,
  p_notes            := 'TESTE 4 — Credito 3x + Pix',
  p_items            := (SELECT jsonb_build_array(jsonb_build_object('product_variation_id', pv.id, 'quantity', 1, 'unit_price', 300.00, 'unit_cost', s.avg_cost, 'discount_amount', 0)) FROM stock s JOIN product_variations pv ON pv.id = s.product_variation_id JOIN products p ON p.id = pv.product_id JOIN users u ON u.company_id = p.company_id WHERE u.role IN ('admin','seller') AND s.quantity > 0 LIMIT 1),
  p_system_user_id   := (SELECT id FROM users WHERE role IN ('admin','seller') LIMIT 1),
  p_payments         := '[{"method":"credit_card","amount_tendered":200.00,"change_amount":0,"net_amount":200.00,"installments":3,"card_brand":"visa","acquirer":"stone"},{"method":"pix","amount_tendered":100.00,"change_amount":0,"net_amount":100.00}]'::jsonb
) AS resultado;

SELECT s.payment_method AS dominante, s.total FROM sales s ORDER BY s.created_at DESC LIMIT 1;
SELECT sp.method, sp.net_amount, sp.installments, sp.fee_percentage, sp.fee_amount FROM sale_payments sp JOIN sales s ON s.id = sp.sale_id ORDER BY s.created_at DESC, sp.net_amount DESC;
SELECT fe.type, fe.category, fe.description, fe.amount FROM finance_entries fe ORDER BY fe.created_at DESC LIMIT 3;

ROLLBACK;
