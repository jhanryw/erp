-- Migration 023: Adiciona cor Rosê ao variation_values
-- Código SKU: 42 (slug: rose)

INSERT INTO variation_values (variation_type_id, value, slug)
SELECT vt.id, 'Rosê', 'rose'
FROM variation_types vt
WHERE vt.slug = 'cor'
ON CONFLICT DO NOTHING;
