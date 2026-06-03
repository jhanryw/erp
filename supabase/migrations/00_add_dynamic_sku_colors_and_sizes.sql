-- =============================================================================
-- Migration: 00_add_dynamic_sku_colors_and_sizes.sql
--
-- Objetivo: tornar a geração de SKU dinâmica para cores e tamanhos.
--           Adiciona sku_code e normalized_name em variation_values,
--           popula os registros existentes, e insere as novas cores
--           solicitadas.
--
-- Idempotente: pode ser re-executada sem duplicar dados.
-- Não altera nem remove dados existentes.
-- =============================================================================

-- ─── 1. Função de normalização (espelha normalizeKey do TypeScript) ───────────
-- Remove acentos, converte para minúsculas, substitui não-alfanuméricos por '_',
-- colapsa '__' em '_' e remove '_' do início/fim.
-- IMMUTABLE STRICT: cacheável, retorna NULL para entrada NULL.

CREATE OR REPLACE FUNCTION normalize_sku_name(p_name TEXT) RETURNS TEXT
LANGUAGE sql IMMUTABLE STRICT AS $$
  SELECT regexp_replace(
    regexp_replace(
      regexp_replace(
        lower(
          translate(
            trim(p_name),
            'àáâãäçèéêëìíîïñòóôõöùúûüýÿÀÁÂÃÄÇÈÉÊËÌÍÎÏÑÒÓÔÕÖÙÚÛÜÝ',
            'aaaaaaceeeeiiiinooooouuuuyyaaaaaceeeeiiiinooooouuuuy'
          )
        ),
        '[^a-z0-9]+', '_', 'g'
      ),
      '_+', '_', 'g'
    ),
    '^_|_$', '', 'g'
  )
$$;

-- ─── 2. Adicionar colunas se ainda não existirem ──────────────────────────────

ALTER TABLE variation_values
  ADD COLUMN IF NOT EXISTS normalized_name TEXT,
  ADD COLUMN IF NOT EXISTS sku_code        TEXT;

-- ─── 3. Preencher normalized_name para todos os registros sem ela ─────────────

UPDATE variation_values
SET normalized_name = normalize_sku_name(value)
WHERE normalized_name IS NULL;

-- ─── 4. Deduplicar antes de criar índice ─────────────────────────────────────
-- Mantém o registro com mais usos em product_variation_attributes.
-- Em caso de empate, mantém o menor id. Seguro para re-execução.

WITH ranked AS (
  SELECT
    id,
    ROW_NUMBER() OVER (
      PARTITION BY variation_type_id, normalized_name
      ORDER BY
        (SELECT count(*) FROM product_variation_attributes pva
         WHERE pva.variation_value_id = vv.id) DESC,
        id ASC
    ) AS rn
  FROM variation_values vv
  WHERE normalized_name IS NOT NULL
)
DELETE FROM variation_values
WHERE id IN (SELECT id FROM ranked WHERE rn > 1);

-- ─── 5. Índice único em (variation_type_id, normalized_name) ─────────────────
-- Previne duplicatas por variação de capitalização, acento ou espaço.

CREATE UNIQUE INDEX IF NOT EXISTS uq_vv_type_normalized
  ON variation_values (variation_type_id, normalized_name)
  WHERE normalized_name IS NOT NULL;

-- ─── 6. Índice único em (variation_type_id, sku_code) ────────────────────────
-- Evita colisão de código entre cores/tamanhos do mesmo tipo.

CREATE UNIQUE INDEX IF NOT EXISTS uq_vv_type_sku_code
  ON variation_values (variation_type_id, sku_code)
  WHERE sku_code IS NOT NULL;

-- ─── 7. Popular sku_code para cores e tamanhos existentes ────────────────────

DO $$
DECLARE
  v_cor_id     INT;
  v_tamanho_id INT;
BEGIN

  SELECT id INTO v_cor_id
  FROM variation_types WHERE lower(name) = 'cor' LIMIT 1;

  SELECT id INTO v_tamanho_id
  FROM variation_types WHERE lower(name) = 'tamanho' LIMIT 1;

  -- ── 6a. Cores do mapa oficial (46 códigos) ─────────────────────────────────
  -- Só atualiza onde sku_code ainda é NULL — idempotente.
  IF v_cor_id IS NOT NULL THEN
    UPDATE variation_values AS vv
    SET sku_code = mapping.code
    FROM (VALUES
      ('preto',            '01'),
      ('branco',           '02'),
      ('nude',             '03'),
      ('vermelho',         '04'),
      ('rosa',             '05'),
      ('vinho',            '06'),
      ('azul',             '07'),
      ('verde',            '08'),
      ('amarelo',          '09'),
      ('roxo',             '10'),
      ('bege',             '11'),
      ('marrom',           '12'),
      ('lilas',            '13'),
      ('bege_com_preto',   '14'),
      ('cinza',            '15'),
      ('laranja',          '16'),
      ('dourado',          '17'),
      ('prateado',         '18'),
      ('azul_marinho',     '19'),
      ('rosa_bebe',        '20'),
      ('pink',             '21'),
      ('coral',            '22'),
      ('off_white',        '23'),
      ('caramelo',         '24'),
      ('verde_oliva',      '25'),
      ('azul_claro',       '26'),
      ('terracota',        '27'),
      ('bordo',            '28'),
      ('champagne',        '29'),
      ('creme',            '30'),
      ('salmao',           '31'),
      ('lavanda',          '32'),
      ('menta',            '33'),
      ('cinza_mescla',     '34'),
      ('nude_escuro',      '35'),
      ('azul_escuro',      '36'),
      ('verde_esmeralda',  '37'),
      ('preto_com_rosa',   '38'),
      ('branco_com_preto', '39'),
      ('cinza_com_preto',  '40'),
      ('rosa_com_preto',   '41'),
      ('rose',             '42'),
      ('chumbo',           '43'),
      ('verde_militar',    '44'),
      ('azul_petroleo',    '45'),
      ('caqui',            '46')
    ) AS mapping(norm, code)
    WHERE vv.variation_type_id = v_cor_id
      AND vv.normalized_name   = mapping.norm
      AND vv.sku_code          IS NULL;
  END IF;

  -- ── 6b. Tamanhos do mapa oficial ───────────────────────────────────────────
  IF v_tamanho_id IS NOT NULL THEN
    UPDATE variation_values AS vv
    SET sku_code = mapping.code
    FROM (VALUES
      ('unico',      '00'),
      ('pp',         '05'),
      ('p',          '01'),
      ('p_m',        '07'),
      ('m',          '02'),
      ('g',          '03'),
      ('g_gg',       '08'),
      ('gg',         '04'),
      ('xg',         '06'),
      ('xgg',        '06'),
      ('g1',         '09'),
      ('g2',         '10'),
      ('g3',         '11'),
      ('m_infantil', '12'),
      ('g_infantil', '13'),
      ('48',         '14'),
      ('50',         '15'),
      ('52',         '16')
    ) AS mapping(norm, code)
    WHERE vv.variation_type_id = v_tamanho_id
      AND vv.normalized_name   = mapping.norm
      AND vv.sku_code          IS NULL;
  END IF;

  -- ── 7. Inserir / atualizar novas cores ─────────────────────────────────────
  -- ON CONFLICT(variation_type_id, slug): se já existir, apenas garante sku_code.
  -- "Preto com Rosa" (38) e "Rosa com Preto" (41) já cobertos pelo UPDATE acima.
  -- Aqui entram apenas as que ainda não existem no banco.

  IF v_cor_id IS NOT NULL THEN
    INSERT INTO variation_values
      (variation_type_id, value,                slug,                  normalized_name,       sku_code, active)
    VALUES
      (v_cor_id, 'Verde Água',         'verde-agua',          'verde_agua',          '47', true),
      (v_cor_id, 'Purple',             'purple',              'purple',              '48', true),
      (v_cor_id, 'Malva',              'malva',               'malva',               '49', true),
      (v_cor_id, 'Preto com Vermelho', 'preto-com-vermelho',  'preto_com_vermelho',  '50', true),
      (v_cor_id, 'Branco com Rosa',    'branco-com-rosa',     'branco_com_rosa',     '51', true),
      (v_cor_id, 'Estampado',          'estampado',           'estampado',           '52', true),
      (v_cor_id, 'Preto com Branco',   'preto-com-branco',    'preto_com_branco',    '53', true),
      (v_cor_id, 'Preto com Verde',    'preto-com-verde',     'preto_com_verde',     '54', true),
      (v_cor_id, 'Rosa Seco',          'rosa-seco',           'rosa_seco',           '55', true),
      (v_cor_id, 'Azul',              'azul',                'azul',                '07', true),
      (v_cor_id, 'Rosa Claro',        'rosa-claro',          'rosa_claro',          '56', true)
    ON CONFLICT (variation_type_id, slug) DO UPDATE
      SET normalized_name = EXCLUDED.normalized_name,
          sku_code        = EXCLUDED.sku_code
      WHERE variation_values.sku_code IS NULL;
  END IF;

END $$;
