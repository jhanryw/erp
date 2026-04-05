-- Migration 030: Adiciona cor Azul Petróleo ao variation_values
-- Código SKU: 45 (slug: azul_petroleo)

INSERT INTO variation_values (variation_type_id, value, slug)
SELECT vt.id, 'Azul Petróleo', 'azul_petroleo'
FROM variation_types vt
WHERE vt.slug = 'cor'
ON CONFLICT DO NOTHING;
