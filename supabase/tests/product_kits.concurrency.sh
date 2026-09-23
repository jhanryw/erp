#!/usr/bin/env bash
# =============================================================================
# product_kits.concurrency.sh
#
# KITS — concorrência REAL com duas sessões Postgres simultâneas.
#
#   14. produto × kit : estoque A = 1. Sessão 1 vende A (segura o lock 2s);
#       sessão 2 vende KIT(1×A) ao mesmo tempo → bloqueia no mesmo
#       FOR UPDATE, e ao ganhar o lock enxerga saldo 0 → falha limpa.
#   15. kit × kit     : estoque A = 1. KIT1(1×A) e KIT2(1×A) simultâneos →
#       exatamente uma venda, nenhum saldo negativo.
#   15b. ordem de lock: KITX(A+B) e KITY(B+A) simultâneos, A=B=1 → locks em
#       ordem determinística (por variação) → sem deadlock, uma venda.
#
# Deixa dados COMMITADOS numa empresa de teste própria — rode SOMENTE em
# banco de teste descartável, NUNCA em produção.
#
#   DATABASE_URL=postgres://... bash supabase/tests/product_kits.concurrency.sh
# Sucesso = última linha "product_kits.concurrency: OK".
# =============================================================================
set -euo pipefail

: "${DATABASE_URL:?defina DATABASE_URL (banco de TESTE)}"
PSQL=(psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -qtA)
TAG="conc-$(date +%s)-$$"

"${PSQL[@]}" >/dev/null <<SQL
DO \$\$
DECLARE c int; u uuid := gen_random_uuid(); loc int; cat int; cust int; p int;
  va int; vb int; r jsonb;
BEGIN
  INSERT INTO companies (name, slug) VALUES ('TESTE KITS CONCORRENCIA', '$TAG') RETURNING id INTO c;
  INSERT INTO auth.users (id) VALUES (u);
  INSERT INTO users (id, name, role, company_id) VALUES (u, 'Conc', 'admin', c);
  INSERT INTO stock_locations (company_id, name, slug, is_main_store, priority) VALUES (c, 'Loja', 'loja', true, 1) RETURNING id INTO loc;
  INSERT INTO categories (name, slug, company_id) VALUES ('Conc', '$TAG', c) RETURNING id INTO cat;
  INSERT INTO customers (name, company_id) VALUES ('Conc', c) RETURNING id INTO cust;
  INSERT INTO products (name, sku, category_id, base_cost, base_price, company_id, tipo, modelo, ano)
    VALUES ('Conc Base', 'CONC', cat, 1, 10, c, 'calcinha', 'conc', '2026') RETURNING id INTO p;
  INSERT INTO product_variations (product_id, sku_variation) VALUES (p, '$TAG-A') RETURNING id INTO va;
  INSERT INTO product_variations (product_id, sku_variation) VALUES (p, '$TAG-B') RETURNING id INTO vb;
  r := public.rpc_create_kit_product(u,
    jsonb_build_object('name', 'Conc Kits', 'sku', '$TAG-K', 'category_id', cat, 'base_price', 20),
    jsonb_build_array(
      jsonb_build_object('sku_variation', '$TAG-K1', 'components', jsonb_build_array(jsonb_build_object('component_product_variation_id', va, 'quantity', 1))),
      jsonb_build_object('sku_variation', '$TAG-K2', 'components', jsonb_build_array(jsonb_build_object('component_product_variation_id', va, 'quantity', 1))),
      jsonb_build_object('sku_variation', '$TAG-KX', 'components', jsonb_build_array(
        jsonb_build_object('component_product_variation_id', va, 'quantity', 1),
        jsonb_build_object('component_product_variation_id', vb, 'quantity', 1))),
      jsonb_build_object('sku_variation', '$TAG-KY', 'components', jsonb_build_array(
        jsonb_build_object('component_product_variation_id', vb, 'quantity', 1),
        jsonb_build_object('component_product_variation_id', va, 'quantity', 1)))));
END \$\$;
SQL
read -r COMPANY USER_ID LOC CUST VA VB K1 K2 KX KY <<<"$("${PSQL[@]}" -c "
    SELECT c.id, u.id, l.id, cu.id,
      (SELECT id FROM product_variations WHERE sku_variation='$TAG-A'),
      (SELECT id FROM product_variations WHERE sku_variation='$TAG-B'),
      (SELECT id FROM product_variations WHERE sku_variation='$TAG-K1'),
      (SELECT id FROM product_variations WHERE sku_variation='$TAG-K2'),
      (SELECT id FROM product_variations WHERE sku_variation='$TAG-KX'),
      (SELECT id FROM product_variations WHERE sku_variation='$TAG-KY')
    FROM companies c JOIN users u ON u.company_id=c.id JOIN stock_locations l ON l.company_id=c.id
    JOIN customers cu ON cu.company_id=c.id WHERE c.slug='$TAG'" | tr '|' ' ')"

set_stock() { # pvid qty
  "${PSQL[@]}" -c "SELECT set_config('app.stock_rpc','1',false);
    INSERT INTO stock_balances (product_variation_id, stock_location_id, quantity) VALUES ($1, $LOC, $2)
    ON CONFLICT (product_variation_id, stock_location_id) DO UPDATE SET quantity = EXCLUDED.quantity;" >/dev/null
}

sale_sql() { # pvid sleep_seconds
  cat <<SQL
BEGIN;
SELECT public.rpc_create_sale(
  p_customer_id => $CUST, p_seller_id => '$USER_ID', p_payment_method => 'pix'::payment_method,
  p_sale_origin => NULL, p_discount_amount => 0, p_cashback_used => 0, p_shipping_charged => 0,
  p_notes => 'concorrencia', p_items => '[{"product_variation_id":$1,"quantity":1,"unit_price":10,"unit_cost":0}]'::jsonb,
  p_system_user_id => '$USER_ID', p_stock_mode => 'main_store');
SELECT pg_sleep($2);
COMMIT;
SQL
}

run_pair() { # label pvid1 pvid2
  local out1 out2 rc1=0 rc2=0
  out1=$(mktemp); out2=$(mktemp)
  (sale_sql "$2" 2 | "${PSQL[@]}" >"$out1" 2>&1) & p1=$!
  sleep 0.5
  (sale_sql "$3" 0 | "${PSQL[@]}" >"$out2" 2>&1) & p2=$!
  wait $p1 || rc1=$?
  wait $p2 || rc2=$?
  local ok=$(( (rc1 == 0) + (rc2 == 0) ))
  if [ "$ok" -ne 1 ]; then
    echo "FALHOU [$1]: esperado exatamente 1 venda, sessões ok=$ok"; cat "$out1" "$out2"; exit 1
  fi
  if grep -qi deadlock "$out1" "$out2"; then echo "FALHOU [$1]: deadlock"; cat "$out1" "$out2"; exit 1; fi
  echo "ok  $1 — perdedora: $(grep -hoE 'ERROR: +.*' "$out1" "$out2" | head -1)"
  rm -f "$out1" "$out2"
}

assert_eq() { # label sql expected
  local got; got=$("${PSQL[@]}" -c "$2")
  if [ "$got" != "$3" ]; then echo "FALHOU [$1]: esperado $3, obtido $got"; exit 1; fi
  echo "ok  $1"
}

# 14. produto × kit
set_stock "$VA" 1
run_pair "14. produto A × KIT(1×A), A=1" "$VA" "$K1"
assert_eq "14. saldo final de A = 0 (sem negativo)" "SELECT quantity FROM stock_balances WHERE product_variation_id=$VA AND stock_location_id=$LOC" "0"

# 14b. ordem inversa: o kit segura o lock, a venda do produto chega depois
set_stock "$VA" 1
run_pair "14b. KIT(1×A) × produto A, A=1" "$K1" "$VA"
assert_eq "14b. saldo final de A = 0 (sem negativo)" "SELECT quantity FROM stock_balances WHERE product_variation_id=$VA AND stock_location_id=$LOC" "0"

# 15. kit × kit
set_stock "$VA" 1
run_pair "15. KIT1 × KIT2 compartilhando A, A=1" "$K1" "$K2"
assert_eq "15. saldo final de A = 0 (sem negativo)" "SELECT quantity FROM stock_balances WHERE product_variation_id=$VA AND stock_location_id=$LOC" "0"

# 15b. ordem de lock determinística
set_stock "$VA" 1; set_stock "$VB" 1
run_pair "15b. KITX(A+B) × KITY(B+A) sem deadlock" "$KX" "$KY"
assert_eq "15b. A = 0" "SELECT quantity FROM stock_balances WHERE product_variation_id=$VA AND stock_location_id=$LOC" "0"
assert_eq "15b. B = 0" "SELECT quantity FROM stock_balances WHERE product_variation_id=$VB AND stock_location_id=$LOC" "0"

assert_eq "nenhum saldo negativo na empresa de teste" \
  "SELECT count(*) FROM stock_balances sb JOIN stock_locations l ON l.id=sb.stock_location_id WHERE l.company_id=$COMPANY AND sb.quantity < 0" "0"
assert_eq "nenhum saldo físico para kits" \
  "SELECT count(*) FROM stock_balances WHERE product_variation_id IN ($K1,$K2,$KX,$KY)" "0"

echo "product_kits.concurrency: OK"
