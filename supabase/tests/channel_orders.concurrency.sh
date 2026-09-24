#!/usr/bin/env bash
# =============================================================================
# channel_orders.concurrency.sh — Fase 3 marketplace, duas sessões REAIS.
#
#   A. PDV × Mercado Livre: estoque = 1. Sessão 1 vende no PDV e segura a
#      transação 2s; sessão 2 importa o pedido ML da mesma variação ao mesmo
#      tempo → bloqueia no lock do saldo; ao prosseguir vê 0 → pedido vai
#      para needs_attention (insufficient_stock). Sem saldo negativo, 1 venda.
#   C. Duas OFERTAS da mesma variação (Clássico × Premium) vendem a última
#      unidade ao mesmo tempo → estoque-mãe único: 1 venda, o outro pedido
#      needs_attention, saldo 0.
#   B. Webhook duplicado concorrente: duas sessões importam o MESMO pedido ao
#      mesmo tempo → o lock do channel_order serializa; exatamente 1 venda,
#      a outra sessão recebe already_imported.
#
# Deixa dados COMMITADOS numa empresa de teste própria — rode SOMENTE em
# banco de teste descartável, NUNCA em produção.
#   DATABASE_URL=postgres://... bash supabase/tests/channel_orders.concurrency.sh
# Sucesso = última linha "channel_orders.concurrency: OK".
# =============================================================================
set -euo pipefail

: "${DATABASE_URL:?defina DATABASE_URL (banco de TESTE)}"
PSQL=(psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -qtA)
TAG="coconc-$(date +%s)-$$"

"${PSQL[@]}" >/dev/null <<SQL
DO \$\$
DECLARE c int; u uuid := gen_random_uuid(); loc int; cat int; cust int; p int; v int; i bigint;
BEGIN
  INSERT INTO companies (name, slug) VALUES ('TESTE CHANNEL ORDERS CONC', '$TAG') RETURNING id INTO c;
  INSERT INTO auth.users (id) VALUES (u);
  INSERT INTO users (id, name, role, company_id) VALUES (u, 'Conc', 'admin', c);
  INSERT INTO stock_locations (company_id, name, slug, is_main_store, priority) VALUES (c, 'Loja', 'loja', true, 1) RETURNING id INTO loc;
  INSERT INTO categories (name, slug, company_id) VALUES ('Conc', '$TAG', c) RETURNING id INTO cat;
  INSERT INTO customers (name, company_id) VALUES ('Conc PDV', c) RETURNING id INTO cust;
  INSERT INTO products (name, sku, category_id, base_cost, base_price, company_id, tipo, modelo, ano)
    VALUES ('Conc', '$TAG-P', cat, 1, 10, c, 'calcinha', 'conc', '2026') RETURNING id INTO p;
  INSERT INTO product_variations (product_id, sku_variation) VALUES (p, 'TEST-ML-$TAG') RETURNING id INTO v;
  INSERT INTO company_integrations (company_id, provider, status, external_account_id, created_by)
    VALUES (c, 'mercadolivre', 'active', '$TAG', u) RETURNING id INTO i;
  INSERT INTO channel_listings (company_id, integration_id, provider, product_id, product_variation_id, seller_sku, external_listing_id, local_status)
    VALUES (c, i, 'mercadolivre', p, v, 'TEST-ML-$TAG', 'MLB-$TAG', 'active');
END \$\$;
SQL

read -r COMPANY USER_ID LOC CUST VAR INT LST <<<"$("${PSQL[@]}" -c "
  SELECT c.id, u.id, l.id, cu.id, pv.id, ci.id, cl.id
  FROM companies c JOIN users u ON u.company_id = c.id JOIN stock_locations l ON l.company_id = c.id
  JOIN customers cu ON cu.company_id = c.id JOIN company_integrations ci ON ci.company_id = c.id
  JOIN channel_listings cl ON cl.company_id = c.id JOIN product_variations pv ON pv.id = cl.product_variation_id
  WHERE c.slug = '$TAG'" | tr '|' ' ')"

set_stock() {
  "${PSQL[@]}" -c "SELECT set_config('app.stock_rpc','1',false);
    INSERT INTO stock_balances (product_variation_id, stock_location_id, quantity) VALUES ($VAR, $LOC, $1)
    ON CONFLICT (product_variation_id, stock_location_id) DO UPDATE SET quantity = EXCLUDED.quantity;" >/dev/null
}

new_order() { # external_order_id → channel_order_id
  "${PSQL[@]}" -c "SELECT (public.rpc_upsert_channel_order($COMPANY, $INT, 'mercadolivre',
    jsonb_build_object('external_order_id', '$1', 'channel_status', 'paid', 'buyer_external_id', 'B-$TAG', 'currency', 'BRL',
      'gross_amount', 10, 'paid_amount', 10, 'marketplace_fees', 1.5, 'shipping_cost_seller', 0, 'net_amount', 8.5),
    jsonb_build_array(jsonb_build_object('external_item_id', 'MLB-$TAG', 'seller_sku', 'TEST-ML-$TAG', 'quantity', 1, 'unit_price', 10,
      'sale_fee', 1.5, 'channel_listing_id', $LST, 'product_variation_id', $VAR, 'mapping_status', 'mapped')))->>'channel_order_id')"
}

import_sql() { # channel_order_id sleep
  cat <<SQL
BEGIN;
SELECT public.rpc_import_channel_order($COMPANY, $1, '$USER_ID',
  '[{"method":"credit_card","net_amount":10,"installments":1,"external_payment_id":"P-$1"}]'::jsonb)->>'result';
SELECT pg_sleep($2);
COMMIT;
SQL
}

# ─── A. PDV × ML ─────────────────────────────────────────────────────────────
set_stock 1
CO_A=$(new_order "A-$TAG")
{
  cat <<SQL
BEGIN;
SELECT public.rpc_create_sale(
  p_customer_id => $CUST, p_seller_id => '$USER_ID', p_payment_method => 'pix'::payment_method,
  p_sale_origin => NULL, p_discount_amount => 0, p_cashback_used => 0, p_shipping_charged => 0,
  p_notes => 'PDV concorrente', p_items => '[{"product_variation_id":$VAR,"quantity":1,"unit_price":10,"unit_cost":1}]'::jsonb,
  p_system_user_id => '$USER_ID', p_stock_mode => 'main_store', p_sales_channel => 'pos') IS NOT NULL;
SELECT pg_sleep(2);
COMMIT;
SQL
} | "${PSQL[@]}" >/dev/null &
PDV_PID=$!
sleep 0.5
ML_RESULT=$(import_sql "$CO_A" 0 | "${PSQL[@]}" | grep -v '^$' | head -1)
wait $PDV_PID

STATE=$("${PSQL[@]}" -c "SELECT processing_state || '|' || COALESCE(attention_code,'') || '|' || COALESCE(sale_id::text,'') FROM channel_orders WHERE id = $CO_A")
QTY=$("${PSQL[@]}" -c "SELECT quantity FROM stock_balances WHERE product_variation_id = $VAR AND stock_location_id = $LOC")
[ "$ML_RESULT" = "needs_attention" ] || { echo "FALHOU A: import ML devolveu '$ML_RESULT'"; exit 1; }
[ "$STATE" = "needs_attention|insufficient_stock|" ] || { echo "FALHOU A: estado '$STATE'"; exit 1; }
[ "$QTY" = "0" ] || { echo "FALHOU A: saldo '$QTY' (esperado 0, nunca negativo)"; exit 1; }
echo "ok  A. PDV venceu o lock; pedido ML → needs_attention/insufficient_stock; saldo 0 (sem negativo)"

# ─── B. mesmo pedido importado por 2 sessões ao mesmo tempo ─────────────────
set_stock 5
CO_B=$(new_order "B-$TAG")
R1_FILE=$(mktemp); R2_FILE=$(mktemp)
(import_sql "$CO_B" 2 | "${PSQL[@]}" | grep -v '^$' | head -1 > "$R1_FILE") &
P1=$!
sleep 0.5
(import_sql "$CO_B" 0 | "${PSQL[@]}" | grep -v '^$' | head -1 > "$R2_FILE") &
P2=$!
wait $P1 $P2
RESULTS="$(cat "$R1_FILE")|$(cat "$R2_FILE")"
rm -f "$R1_FILE" "$R2_FILE"
SALES=$("${PSQL[@]}" -c "SELECT count(*) FROM sales WHERE notes = 'Pedido Mercado Livre #B-$TAG'")
QTY=$("${PSQL[@]}" -c "SELECT quantity FROM stock_balances WHERE product_variation_id = $VAR AND stock_location_id = $LOC")
[ "$RESULTS" = "imported|already_imported" ] || { echo "FALHOU B: resultados '$RESULTS'"; exit 1; }
[ "$SALES" = "1" ] || { echo "FALHOU B: $SALES vendas"; exit 1; }
[ "$QTY" = "4" ] || { echo "FALHOU B: saldo '$QTY' (esperado 4 — uma única baixa)"; exit 1; }
echo "ok  B. importação concorrente do mesmo pedido → 1 venda, 1 baixa (a outra sessão: already_imported)"

# ─── C. duas ofertas da mesma variação disputam a última unidade ─────────────
"${PSQL[@]}" -c "INSERT INTO channel_listings (company_id, integration_id, provider, product_id, product_variation_id, seller_sku, external_listing_id, local_status, offer_key, listing_type_id)
  SELECT company_id, integration_id, provider, product_id, product_variation_id, seller_sku, 'MLB-$TAG-PRO', 'active', 'gold_pro', 'gold_pro'
  FROM channel_listings WHERE id = $LST" >/dev/null
LST_PRO=$("${PSQL[@]}" -c "SELECT id FROM channel_listings WHERE external_listing_id = 'MLB-$TAG-PRO'")
set_stock 1
CO_C1=$(new_order "C1-$TAG")
CO_C2=$("${PSQL[@]}" -c "SELECT (public.rpc_upsert_channel_order($COMPANY, $INT, 'mercadolivre',
    jsonb_build_object('external_order_id', 'C2-$TAG', 'channel_status', 'paid', 'buyer_external_id', 'B2-$TAG', 'currency', 'BRL',
      'gross_amount', 10, 'paid_amount', 10, 'marketplace_fees', 1.5, 'shipping_cost_seller', 0, 'net_amount', 8.5),
    jsonb_build_array(jsonb_build_object('external_item_id', 'MLB-$TAG-PRO', 'seller_sku', 'TEST-ML-$TAG', 'quantity', 1, 'unit_price', 10,
      'sale_fee', 1.5, 'channel_listing_id', $LST_PRO, 'product_variation_id', $VAR, 'mapping_status', 'mapped')))->>'channel_order_id')")
R1_FILE=$(mktemp); R2_FILE=$(mktemp)
(import_sql "$CO_C1" 2 | "${PSQL[@]}" | grep -v '^$' | head -1 > "$R1_FILE") &
P1=$!
sleep 0.5
(import_sql "$CO_C2" 0 | "${PSQL[@]}" | grep -v '^$' | head -1 > "$R2_FILE") &
P2=$!
wait $P1 $P2
RESULTS="$(cat "$R1_FILE")|$(cat "$R2_FILE")"
rm -f "$R1_FILE" "$R2_FILE"
QTY=$("${PSQL[@]}" -c "SELECT quantity FROM stock_balances WHERE product_variation_id = $VAR AND stock_location_id = $LOC")
ORIGIN=$("${PSQL[@]}" -c "SELECT channel_listing_id FROM channel_order_items WHERE channel_order_id = $CO_C1")
[ "$RESULTS" = "imported|needs_attention" ] || { echo "FALHOU C: resultados '$RESULTS'"; exit 1; }
[ "$QTY" = "0" ] || { echo "FALHOU C: saldo '$QTY' (esperado 0, nunca negativo)"; exit 1; }
[ "$ORIGIN" = "$LST" ] || { echo "FALHOU C: oferta de origem '$ORIGIN'"; exit 1; }
echo "ok  C. Clássico × Premium pela última unidade → 1 venda (oferta registrada), outra needs_attention; saldo 0"

echo "channel_orders.concurrency: OK"
