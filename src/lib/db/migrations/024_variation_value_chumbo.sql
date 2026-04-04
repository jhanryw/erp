-- Migration 024: Adiciona cor Chumbo ao variation_values
-- Código SKU: 43 (slug: chumbo)

INSERT INTO variation_values (variation_type_id, value, slug)
SELECT vt.id, 'Chumbo', 'chumbo'
FROM variation_types vt
WHERE vt.slug = 'cor'
ON CONFLICT DO NOTHING;
