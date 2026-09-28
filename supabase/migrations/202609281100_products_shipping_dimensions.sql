-- Dados físicos de envio no PIM (provider-agnostic: Shopee, ML, Nuvemshop, frete).
--
-- products: peso (kg) e dimensões da EMBALAGEM (cm) do produto.
-- product_variations: overrides opcionais — mesmo padrão já usado por
--   price_override / cost_override / wholesale_price_override
--   (NULL = herda do produto-pai). Regra de resolução em
--   src/services/catalog/shippingDimensions.ts (resolveProductShippingDimensions).
--
-- Tipos:
--   peso  NUMERIC(10,3) — precisão de grama; canais aceitam float kg.
--   dimensões INTEGER cm — Shopee (int32 cm), ML e Correios trabalham com cm
--   inteiros; evita arredondamento implícito na hora de publicar.
-- Tudo nullable, SEM default fictício. CHECK impede valor <= 0 quando preenchido.

ALTER TABLE public.products
  ADD COLUMN IF NOT EXISTS weight_kg         NUMERIC(10,3),
  ADD COLUMN IF NOT EXISTS package_length_cm INTEGER,
  ADD COLUMN IF NOT EXISTS package_width_cm  INTEGER,
  ADD COLUMN IF NOT EXISTS package_height_cm INTEGER;

ALTER TABLE public.product_variations
  ADD COLUMN IF NOT EXISTS weight_kg_override         NUMERIC(10,3),
  ADD COLUMN IF NOT EXISTS package_length_cm_override INTEGER,
  ADD COLUMN IF NOT EXISTS package_width_cm_override  INTEGER,
  ADD COLUMN IF NOT EXISTS package_height_cm_override INTEGER;

-- CHECKs idempotentes (re-executar a migration não falha).
DO $$
DECLARE r record;
BEGIN
  FOR r IN SELECT * FROM (VALUES
    ('products', 'products_weight_kg_positive', 'weight_kg'),
    ('products', 'products_package_length_cm_positive', 'package_length_cm'),
    ('products', 'products_package_width_cm_positive', 'package_width_cm'),
    ('products', 'products_package_height_cm_positive', 'package_height_cm'),
    ('product_variations', 'product_variations_weight_kg_override_positive', 'weight_kg_override'),
    ('product_variations', 'product_variations_package_length_cm_override_positive', 'package_length_cm_override'),
    ('product_variations', 'product_variations_package_width_cm_override_positive', 'package_width_cm_override'),
    ('product_variations', 'product_variations_package_height_cm_override_positive', 'package_height_cm_override')
  ) AS t(tbl, con, col) LOOP
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = r.con AND conrelid = format('public.%I', r.tbl)::regclass) THEN
      EXECUTE format('ALTER TABLE public.%I ADD CONSTRAINT %I CHECK (%I IS NULL OR %I > 0)', r.tbl, r.con, r.col, r.col);
    END IF;
  END LOOP;
END $$;

COMMENT ON COLUMN public.products.weight_kg         IS 'Peso do produto embalado, em kg (NULL = não cadastrado; nunca 0).';
COMMENT ON COLUMN public.products.package_length_cm IS 'Comprimento da embalagem, em cm inteiros (NULL = não cadastrado).';
COMMENT ON COLUMN public.products.package_width_cm  IS 'Largura da embalagem, em cm inteiros (NULL = não cadastrado).';
COMMENT ON COLUMN public.products.package_height_cm IS 'Altura da embalagem, em cm inteiros (NULL = não cadastrado).';
COMMENT ON COLUMN public.product_variations.weight_kg_override         IS 'Peso específico da variação (kg). NULL = usa products.weight_kg.';
COMMENT ON COLUMN public.product_variations.package_length_cm_override IS 'Comprimento específico (cm). NULL = usa products.package_length_cm.';
COMMENT ON COLUMN public.product_variations.package_width_cm_override  IS 'Largura específica (cm). NULL = usa products.package_width_cm.';
COMMENT ON COLUMN public.product_variations.package_height_cm_override IS 'Altura específica (cm). NULL = usa products.package_height_cm.';
