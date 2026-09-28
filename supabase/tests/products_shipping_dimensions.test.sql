-- =============================================================================
-- products_shipping_dimensions.test.sql — migration 202609281100
-- (peso/dimensões em products + overrides em product_variations).
-- BEGIN/ROLLBACK, dados próprios. Ambiente de TESTE apenas:
--   psql -v ON_ERROR_STOP=1 "$DATABASE_URL" -f supabase/tests/products_shipping_dimensions.test.sql
-- Sucesso = "products_shipping_dimensions: TODOS OS CENÁRIOS PASSARAM".
-- =============================================================================
BEGIN;

CREATE FUNCTION pg_temp.expect_check(stmt text, label text) RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  BEGIN
    EXECUTE stmt;
  EXCEPTION WHEN check_violation THEN
    RAISE NOTICE 'ok  % (CHECK barrou)', label;
    RETURN;
  END;
  RAISE EXCEPTION 'FALHOU [%]: CHECK não barrou', label;
END $$;

CREATE TEMP TABLE ctx (k text PRIMARY KEY, v int) ON COMMIT DROP;
DO $$
DECLARE c int; cat int; p int; v int; u text := gen_random_uuid()::text;
BEGIN
  INSERT INTO companies (name, slug) VALUES ('TESTE FISICO', 'teste-fisico-' || u) RETURNING id INTO c;
  INSERT INTO categories (name, slug) VALUES ('TESTE FISICO', 'teste-fisico-' || u) RETURNING id INTO cat;
  INSERT INTO products (company_id, category_id, name, sku, base_price, tipo, modelo, ano)
    VALUES (c, cat, 'Produto físico', 'FIS-' || u, 10, 'X', 'Y', '26') RETURNING id INTO p;
  INSERT INTO product_variations (product_id, sku_variation) VALUES (p, 'FIS-V-' || u) RETURNING id INTO v;
  INSERT INTO ctx VALUES ('p', p), ('v', v);
END $$;

-- nullable: produto/variação sem dado físico continuam válidos (sem default fictício)
DO $$
DECLARE r record;
BEGIN
  SELECT weight_kg, package_length_cm, package_width_cm, package_height_cm INTO r FROM products WHERE id = (SELECT v FROM ctx WHERE k = 'p');
  IF r.weight_kg IS NOT NULL OR r.package_length_cm IS NOT NULL OR r.package_width_cm IS NOT NULL OR r.package_height_cm IS NOT NULL THEN
    RAISE EXCEPTION 'FALHOU [default]: esperado NULL';
  END IF;
  RAISE NOTICE 'ok  nullable sem default';
END $$;

-- valores válidos
UPDATE products SET weight_kg = 0.350, package_length_cm = 25, package_width_cm = 18, package_height_cm = 4 WHERE id = (SELECT v FROM ctx WHERE k = 'p');
UPDATE product_variations SET weight_kg_override = 0.5, package_height_cm_override = 6 WHERE id = (SELECT v FROM ctx WHERE k = 'v');
-- dimensão parcial é permitida no banco (o bloqueio é por canal na publicação)
UPDATE products SET package_length_cm = NULL WHERE id = (SELECT v FROM ctx WHERE k = 'p');

SELECT pg_temp.expect_check(format('UPDATE products SET weight_kg = 0 WHERE id = %s', (SELECT v FROM ctx WHERE k = 'p')), 'peso zero produto');
SELECT pg_temp.expect_check(format('UPDATE products SET weight_kg = -1 WHERE id = %s', (SELECT v FROM ctx WHERE k = 'p')), 'peso negativo produto');
SELECT pg_temp.expect_check(format('UPDATE products SET package_length_cm = 0 WHERE id = %s', (SELECT v FROM ctx WHERE k = 'p')), 'comprimento zero');
SELECT pg_temp.expect_check(format('UPDATE products SET package_width_cm = -3 WHERE id = %s', (SELECT v FROM ctx WHERE k = 'p')), 'largura negativa');
SELECT pg_temp.expect_check(format('UPDATE products SET package_height_cm = 0 WHERE id = %s', (SELECT v FROM ctx WHERE k = 'p')), 'altura zero');
SELECT pg_temp.expect_check(format('UPDATE product_variations SET weight_kg_override = 0 WHERE id = %s', (SELECT v FROM ctx WHERE k = 'v')), 'peso zero variação');
SELECT pg_temp.expect_check(format('UPDATE product_variations SET package_length_cm_override = 0 WHERE id = %s', (SELECT v FROM ctx WHERE k = 'v')), 'comprimento zero variação');
SELECT pg_temp.expect_check(format('UPDATE product_variations SET package_width_cm_override = -1 WHERE id = %s', (SELECT v FROM ctx WHERE k = 'v')), 'largura negativa variação');
SELECT pg_temp.expect_check(format('UPDATE product_variations SET package_height_cm_override = 0 WHERE id = %s', (SELECT v FROM ctx WHERE k = 'v')), 'altura zero variação');

DO $$ BEGIN RAISE NOTICE 'products_shipping_dimensions: TODOS OS CENÁRIOS PASSARAM'; END $$;
ROLLBACK;
