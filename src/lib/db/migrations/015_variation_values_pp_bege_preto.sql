-- Migration 015: Adiciona novos tamanhos e cores em variation_values
--
-- Inclui: PP, XGG e 28 novas cores para cobrir toda a paleta de lingerie/moda íntima.
-- Idempotente via ON CONFLICT DO NOTHING.

DO $$
DECLARE
  v_tipo_tamanho_id INT;
  v_tipo_cor_id     INT;
BEGIN
  SELECT id INTO v_tipo_tamanho_id
  FROM variation_types WHERE lower(name) = 'tamanho' LIMIT 1;

  IF v_tipo_tamanho_id IS NULL THEN
    RAISE EXCEPTION 'variation_type "tamanho" não encontrado. Rode as migrations anteriores primeiro.';
  END IF;

  SELECT id INTO v_tipo_cor_id
  FROM variation_types WHERE lower(name) = 'cor' LIMIT 1;

  IF v_tipo_cor_id IS NULL THEN
    RAISE EXCEPTION 'variation_type "cor" não encontrado. Rode as migrations anteriores primeiro.';
  END IF;

  -- ── Tamanhos ────────────────────────────────────────────────────────────────
  INSERT INTO variation_values (variation_type_id, value, slug) VALUES
    (v_tipo_tamanho_id, 'PP',  'pp'),
    (v_tipo_tamanho_id, 'XGG', 'xgg')
  ON CONFLICT DO NOTHING;

  -- ── Cores ───────────────────────────────────────────────────────────────────
  INSERT INTO variation_values (variation_type_id, value, slug) VALUES
    (v_tipo_cor_id, 'Bege com Preto',    'bege-com-preto'),
    (v_tipo_cor_id, 'Cinza',             'cinza'),
    (v_tipo_cor_id, 'Laranja',           'laranja'),
    (v_tipo_cor_id, 'Dourado',           'dourado'),
    (v_tipo_cor_id, 'Prateado',          'prateado'),
    (v_tipo_cor_id, 'Azul Marinho',      'azul-marinho'),
    (v_tipo_cor_id, 'Rosa Bebê',         'rosa-bebe'),
    (v_tipo_cor_id, 'Pink',              'pink'),
    (v_tipo_cor_id, 'Coral',             'coral'),
    (v_tipo_cor_id, 'Off White',         'off-white'),
    (v_tipo_cor_id, 'Caramelo',          'caramelo'),
    (v_tipo_cor_id, 'Verde Oliva',       'verde-oliva'),
    (v_tipo_cor_id, 'Azul Celeste',      'azul-celeste'),
    (v_tipo_cor_id, 'Terracota',         'terracota'),
    (v_tipo_cor_id, 'Bordô',             'bordo'),
    (v_tipo_cor_id, 'Champagne',         'champagne'),
    (v_tipo_cor_id, 'Creme',             'creme'),
    (v_tipo_cor_id, 'Salmão',            'salmao'),
    (v_tipo_cor_id, 'Lavanda',           'lavanda'),
    (v_tipo_cor_id, 'Menta',             'menta'),
    (v_tipo_cor_id, 'Cinza Mescla',      'cinza-mescla'),
    (v_tipo_cor_id, 'Nude Escuro',       'nude-escuro'),
    (v_tipo_cor_id, 'Azul Royal',        'azul-royal'),
    (v_tipo_cor_id, 'Verde Esmeralda',   'verde-esmeralda'),
    (v_tipo_cor_id, 'Preto com Rosa',    'preto-com-rosa'),
    (v_tipo_cor_id, 'Branco com Preto',  'branco-com-preto'),
    (v_tipo_cor_id, 'Cinza com Preto',   'cinza-com-preto'),
    (v_tipo_cor_id, 'Rosa com Preto',    'rosa-com-preto')
  ON CONFLICT DO NOTHING;

END $$;
