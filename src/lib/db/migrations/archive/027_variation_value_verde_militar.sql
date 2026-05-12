-- Migration 027: Adiciona cor Verde Militar ao variation_values
-- Código SKU: 44 (slug: verde_militar)

INSERT INTO variation_values (variation_type_id, value, slug)
SELECT vt.id, 'Verde Militar', 'verde_militar'
FROM variation_types vt
WHERE vt.slug = 'cor'
ON CONFLICT DO NOTHING;
