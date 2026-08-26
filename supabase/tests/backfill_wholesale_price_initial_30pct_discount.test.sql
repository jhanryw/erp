-- =============================================================================
-- backfill_wholesale_price_initial_30pct_discount.test.sql
--
-- Prova a regra de
-- 202609041400_backfill_wholesale_price_initial_30pct_discount.sql:
--   products.wholesale_price = ROUND(base_price * 0.70, 2), só quando
--   wholesale_price IS NULL e base_price é válido (NOT NULL, > 0).
--   product_variations.wholesale_price_override = ROUND(price_override * 0.70, 2),
--   só quando wholesale_price_override IS NULL e price_override é válido
--   (NOT NULL, > 0). Variação sem price_override NUNCA ganha override
--   automático (continua herdando products.wholesale_price).
--   Nenhum valor de atacado já cadastrado é sobrescrito.
--
-- Roda as MESMAS duas instruções UPDATE da migration (sem filtro de
-- company_id — igual à migration real) dentro de uma transação com
-- ROLLBACK, contra dados sintéticos próprios — nunca toca dado real fora
-- da transação, e prova que linhas reais pré-existentes com wholesale_price
-- já preenchido não seriam afetadas (idempotência).
--
-- COMO RODAR (ambiente de TESTE, nunca produção):
--   psql -v ON_ERROR_STOP=1 "$DATABASE_URL" -f supabase/tests/backfill_wholesale_price_initial_30pct_discount.test.sql
-- =============================================================================

BEGIN;

INSERT INTO public.categories (name, slug, company_id, active)
VALUES ('TESTE Backfill Wholesale Price — APAGAR', 'teste-backfill-wholesale-price-apagar', 1, true)
ON CONFLICT DO NOTHING;

DO $$
DECLARE
  v_category_id            INT;
  v_p_100                  INT; -- base 100.00 → esperado wholesale 70.00
  v_p_69_90                INT; -- base 69.90  → esperado wholesale 48.93
  v_p_existing_wholesale    INT; -- já tem wholesale_price — deve ser preservado
  v_p_zero_base             INT; -- base_price = 0 — não deve ganhar wholesale_price
  v_v_override_80           INT; -- price_override 80.00 → esperado override 56.00
  v_v_no_override           INT; -- sem price_override — nunca ganha wholesale override
  v_v_existing_override     INT; -- já tem wholesale_price_override — deve ser preservado
  v_result NUMERIC;
BEGIN
  SELECT id INTO v_category_id FROM public.categories WHERE slug = 'teste-backfill-wholesale-price-apagar';

  -- ── Setup: produtos sintéticos ───────────────────────────────────────────
  INSERT INTO public.products (name, sku, category_id, company_id, tipo, modelo, ano, base_cost, base_price, wholesale_price, active)
  VALUES ('TESTE Backfill 100', 'TESTE-BACKFILL-WP-100', v_category_id, 1, 'x', 'y', '2026', 10, 100.00, NULL, true)
  RETURNING id INTO v_p_100;

  INSERT INTO public.products (name, sku, category_id, company_id, tipo, modelo, ano, base_cost, base_price, wholesale_price, active)
  VALUES ('TESTE Backfill 69.90', 'TESTE-BACKFILL-WP-6990', v_category_id, 1, 'x', 'y', '2026', 10, 69.90, NULL, true)
  RETURNING id INTO v_p_69_90;

  INSERT INTO public.products (name, sku, category_id, company_id, tipo, modelo, ano, base_cost, base_price, wholesale_price, active)
  VALUES ('TESTE Backfill Já Tem Wholesale', 'TESTE-BACKFILL-WP-EXIST', v_category_id, 1, 'x', 'y', '2026', 10, 200.00, 55.00, true)
  RETURNING id INTO v_p_existing_wholesale;

  INSERT INTO public.products (name, sku, category_id, company_id, tipo, modelo, ano, base_cost, base_price, wholesale_price, active)
  VALUES ('TESTE Backfill Base Zero', 'TESTE-BACKFILL-WP-ZERO', v_category_id, 1, 'x', 'y', '2026', 10, 0, NULL, true)
  RETURNING id INTO v_p_zero_base;

  INSERT INTO public.product_variations (product_id, sku_variation, price_override, wholesale_price_override, active)
  VALUES (v_p_100, 'TESTE-BACKFILL-WP-100-V1', 80.00, NULL, true)
  RETURNING id INTO v_v_override_80;

  INSERT INTO public.product_variations (product_id, sku_variation, price_override, wholesale_price_override, active)
  VALUES (v_p_100, 'TESTE-BACKFILL-WP-100-V2', NULL, NULL, true)
  RETURNING id INTO v_v_no_override;

  INSERT INTO public.product_variations (product_id, sku_variation, price_override, wholesale_price_override, active)
  VALUES (v_p_100, 'TESTE-BACKFILL-WP-100-V3', 120.00, 90.00, true)
  RETURNING id INTO v_v_existing_override;

  -- ═══════════════════════════════════════════════════════════════════════
  -- Aplica exatamente as mesmas 2 instruções da migration
  -- 202609041400_backfill_wholesale_price_initial_30pct_discount.sql
  -- ═══════════════════════════════════════════════════════════════════════
  UPDATE public.products
  SET wholesale_price = ROUND(base_price * 0.70, 2)
  WHERE wholesale_price IS NULL
    AND base_price IS NOT NULL
    AND base_price > 0;

  UPDATE public.product_variations
  SET wholesale_price_override = ROUND(price_override * 0.70, 2)
  WHERE wholesale_price_override IS NULL
    AND price_override IS NOT NULL
    AND price_override > 0;

  -- ── 1. base 100 → wholesale 70.00 ────────────────────────────────────────
  SELECT wholesale_price INTO v_result FROM public.products WHERE id = v_p_100;
  IF v_result IS DISTINCT FROM 70.00 THEN
    RAISE EXCEPTION 'FALHA: base_price=100.00 deveria gerar wholesale_price=70.00, veio %.', v_result;
  END IF;
  RAISE NOTICE 'OK: base 100.00 → wholesale 70.00';

  -- ── 2. base 69.90 → wholesale 48.93 (arredondamento matemático, não psicológico) ──
  SELECT wholesale_price INTO v_result FROM public.products WHERE id = v_p_69_90;
  IF v_result IS DISTINCT FROM 48.93 THEN
    RAISE EXCEPTION 'FALHA: base_price=69.90 deveria gerar wholesale_price=48.93, veio %.', v_result;
  END IF;
  RAISE NOTICE 'OK: base 69.90 → wholesale 48.93 (não 49.90 nem qualquer preço psicológico)';

  -- ── 3. wholesale_price já cadastrado é preservado (nunca sobrescrito) ───
  SELECT wholesale_price INTO v_result FROM public.products WHERE id = v_p_existing_wholesale;
  IF v_result IS DISTINCT FROM 55.00 THEN
    RAISE EXCEPTION 'FALHA: wholesale_price já cadastrado (55.00) deveria ser preservado, veio %.', v_result;
  END IF;
  RAISE NOTICE 'OK: wholesale_price já cadastrado (55.00) preservado — não sobrescrito por base_price*0.70 (140.00)';

  -- ── 4. produto com base_price inválido (0) não é alterado ───────────────
  SELECT wholesale_price INTO v_result FROM public.products WHERE id = v_p_zero_base;
  IF v_result IS NOT NULL THEN
    RAISE EXCEPTION 'FALHA: produto com base_price=0 não deveria ganhar wholesale_price, veio %.', v_result;
  END IF;
  RAISE NOTICE 'OK: produto sem preço de varejo válido (base_price=0) continua sem wholesale_price';

  -- ── 5. override de variação: price_override 80.00 → wholesale override 56.00 ──
  SELECT wholesale_price_override INTO v_result FROM public.product_variations WHERE id = v_v_override_80;
  IF v_result IS DISTINCT FROM 56.00 THEN
    RAISE EXCEPTION 'FALHA: price_override=80.00 deveria gerar wholesale_price_override=56.00, veio %.', v_result;
  END IF;
  RAISE NOTICE 'OK: variação com price_override=80.00 → wholesale_price_override=56.00';

  -- ── 6. variação sem price_override NUNCA ganha wholesale override ───────
  SELECT wholesale_price_override INTO v_result FROM public.product_variations WHERE id = v_v_no_override;
  IF v_result IS NOT NULL THEN
    RAISE EXCEPTION 'FALHA: variação sem price_override não deveria ganhar wholesale_price_override, veio %.', v_result;
  END IF;
  RAISE NOTICE 'OK: variação sem price_override continua com wholesale_price_override NULL — herda products.wholesale_price';

  -- ── 7. wholesale_price_override já cadastrado é preservado ─────────────
  SELECT wholesale_price_override INTO v_result FROM public.product_variations WHERE id = v_v_existing_override;
  IF v_result IS DISTINCT FROM 90.00 THEN
    RAISE EXCEPTION 'FALHA: wholesale_price_override já cadastrado (90.00) deveria ser preservado, veio %.', v_result;
  END IF;
  RAISE NOTICE 'OK: wholesale_price_override já cadastrado (90.00) preservado — não sobrescrito por price_override*0.70 (84.00)';

  -- ── 8. preço de varejo (base_price/price_override) permanece intacto ───
  IF (SELECT base_price FROM public.products WHERE id = v_p_100) IS DISTINCT FROM 100.00 THEN
    RAISE EXCEPTION 'FALHA: base_price do produto 100 não deveria ter mudado.';
  END IF;
  IF (SELECT base_price FROM public.products WHERE id = v_p_69_90) IS DISTINCT FROM 69.90 THEN
    RAISE EXCEPTION 'FALHA: base_price do produto 69.90 não deveria ter mudado.';
  END IF;
  IF (SELECT price_override FROM public.product_variations WHERE id = v_v_override_80) IS DISTINCT FROM 80.00 THEN
    RAISE EXCEPTION 'FALHA: price_override da variação não deveria ter mudado.';
  END IF;
  RAISE NOTICE 'OK: preço de varejo (base_price/price_override) permanece intacto em todos os casos';

  RAISE NOTICE 'backfill_wholesale_price_initial_30pct_discount.test.sql: todos os testes passaram.';
END $$;

ROLLBACK;
