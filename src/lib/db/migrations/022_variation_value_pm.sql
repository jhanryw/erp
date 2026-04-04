-- Migration 022: Adiciona tamanhos P/M e G/GG ao variation_values
--
-- P/M veste tanto P quanto M — código SKU 07 (slug: p_m)
-- G/GG veste tanto G quanto GG — código SKU 08 (slug: g_gg)

INSERT INTO variation_values (variation_type_id, value, slug)
SELECT vt.id, 'P/M', 'p_m'
FROM variation_types vt
WHERE vt.slug = 'tamanho'
ON CONFLICT DO NOTHING;

INSERT INTO variation_values (variation_type_id, value, slug)
SELECT vt.id, 'G/GG', 'g_gg'
FROM variation_types vt
WHERE vt.slug = 'tamanho'
ON CONFLICT DO NOTHING;
