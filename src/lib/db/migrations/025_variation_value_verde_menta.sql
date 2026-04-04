-- Migration 025: Adiciona cor Verde Menta ao variation_values
-- Código SKU: 33 (slug: menta)

INSERT INTO variation_values (variation_type_id, value, slug)
SELECT vt.id, 'Verde Menta', 'menta'
FROM variation_types vt
WHERE vt.slug = 'cor'
ON CONFLICT DO NOTHING;
