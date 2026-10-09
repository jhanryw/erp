-- Personalização dos textos do atacado (Configurações → Atacado → Personalização do site).
--
-- Reaproveita wholesale_site_settings (1 linha por empresa, RLS só service_role,
-- mesmo caminho de leitura/escrita) — nenhuma tabela nova. 100% aditiva: colunas
-- nullable; NULL = usar o texto padrão do código. O valor do pedido mínimo
-- continua em minimum_order_amount (comercial); minimum_order_note é só um texto
-- informativo. Reaplicável.

ALTER TABLE public.wholesale_site_settings
  ADD COLUMN IF NOT EXISTS hero_title          TEXT,
  ADD COLUMN IF NOT EXISTS hero_subtitle       TEXT,
  ADD COLUMN IF NOT EXISTS categories_title    TEXT,
  ADD COLUMN IF NOT EXISTS products_title      TEXT,
  ADD COLUMN IF NOT EXISTS add_also_title      TEXT,
  ADD COLUMN IF NOT EXISTS minimum_order_note  TEXT,
  ADD COLUMN IF NOT EXISTS empty_message       TEXT,
  ADD COLUMN IF NOT EXISTS footer_text         TEXT;

-- Limites espelham siteTexts.ts. Texto vazio nunca é gravado (a API converte em NULL).
ALTER TABLE public.wholesale_site_settings DROP CONSTRAINT IF EXISTS chk_wholesale_site_texts_len;
ALTER TABLE public.wholesale_site_settings ADD CONSTRAINT chk_wholesale_site_texts_len CHECK (
  (hero_title         IS NULL OR char_length(hero_title)         BETWEEN 1 AND 80)  AND
  (hero_subtitle      IS NULL OR char_length(hero_subtitle)      BETWEEN 1 AND 200) AND
  (categories_title   IS NULL OR char_length(categories_title)   BETWEEN 1 AND 60)  AND
  (products_title     IS NULL OR char_length(products_title)     BETWEEN 1 AND 60)  AND
  (add_also_title     IS NULL OR char_length(add_also_title)     BETWEEN 1 AND 60)  AND
  (minimum_order_note IS NULL OR char_length(minimum_order_note) BETWEEN 1 AND 240) AND
  (empty_message      IS NULL OR char_length(empty_message)      BETWEEN 1 AND 200) AND
  (footer_text        IS NULL OR char_length(footer_text)        BETWEEN 1 AND 500)
);

-- ROLLBACK
/*
ALTER TABLE public.wholesale_site_settings DROP CONSTRAINT IF EXISTS chk_wholesale_site_texts_len;
ALTER TABLE public.wholesale_site_settings
  DROP COLUMN IF EXISTS footer_text, DROP COLUMN IF EXISTS empty_message, DROP COLUMN IF EXISTS minimum_order_note,
  DROP COLUMN IF EXISTS add_also_title, DROP COLUMN IF EXISTS products_title, DROP COLUMN IF EXISTS categories_title,
  DROP COLUMN IF EXISTS hero_subtitle, DROP COLUMN IF EXISTS hero_title;
*/
