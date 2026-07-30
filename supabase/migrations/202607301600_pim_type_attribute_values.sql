-- =============================================================================
-- 202607301600_pim_type_attribute_values.sql
--
-- Corrige o gap de governança de valor identificado em testes reais: o
-- endpoint /api/produtos/modelo-options enxergava TODOS os valores do
-- atributo Modelo (Calcinha + Sex Shop juntos), porque ambos compartilham o
-- mesmo variation_type_id e não havia nenhuma restrição por Tipo.
--
-- O QUE FAZ:
--   1. Cria type_attribute_values (product_type_id, variation_value_id) —
--      mesma forma relacional de type_attributes/category_attributes (já
--      estabelecidas), governa quais valores de um atributo são válidos
--      para qual Tipo. N:N de verdade — um valor pode servir a mais de um
--      Tipo no futuro sem duplicar cadastro.
--   2. Ativa variation_types.value_governance='type_restricted' pro
--      atributo Modelo — a coluna já existia desde a Fase A
--      (202607301100), mas ficou em 'unrestricted' "por enquanto" porque só
--      Calcinha usava o atributo na época. Agora que Sex Shop compartilha o
--      mesmo atributo, a restrição passa a ser necessária e real.
--
-- O QUE NÃO FAZ:
--   - Não popula nenhum vínculo ainda — isso é feito ao re-rodar
--     202607301300 (Calcinha) e 202607301400 (Sex Shop), adaptados nesta
--     mesma leva pra inserir em type_attribute_values.
--   - Não cria category_attribute_values — não é necessário agora (nenhum
--     atributo precisa de restrição mais fina que o nível de Tipo ainda).
--   - Não altera Cor/Tamanho — continuam value_governance='unrestricted',
--     comportamento de sempre.
--
-- ORDEM DE APLICAÇÃO: rode esta migration ANTES de re-rodar 202607301300 e
-- 202607301400 (que agora inserem em type_attribute_values — a tabela
-- precisa existir primeiro).
--
-- IDEMPOTENTE: CREATE TABLE/INDEX IF NOT EXISTS; UPDATE guardado por WHERE
-- pra nunca sobrescrever um value_governance já ajustado manualmente depois.
-- =============================================================================

CREATE TABLE IF NOT EXISTS public.type_attribute_values (
  id                  SERIAL      PRIMARY KEY,
  product_type_id     INT         NOT NULL REFERENCES public.product_types(id),
  variation_value_id  INT         NOT NULL REFERENCES public.variation_values(id),
  active              BOOLEAN     NOT NULL DEFAULT TRUE,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT uq_type_attribute_values UNIQUE (product_type_id, variation_value_id)
);

CREATE INDEX IF NOT EXISTS idx_type_attribute_values_product_type_id
  ON public.type_attribute_values(product_type_id);

CREATE INDEX IF NOT EXISTS idx_type_attribute_values_variation_value_id
  ON public.type_attribute_values(variation_value_id);

UPDATE public.variation_types
SET value_governance = 'type_restricted'
WHERE slug = 'modelo' AND value_governance = 'unrestricted';

-- =============================================================================
-- Smoke tests
-- =============================================================================

SELECT table_name FROM information_schema.tables
WHERE table_schema = 'public' AND table_name = 'type_attribute_values';
-- Esperado: 1 linha

SELECT slug, value_governance FROM variation_types WHERE slug = 'modelo';
-- Esperado: 1 linha, value_governance = 'type_restricted'

-- =============================================================================
-- FIM DA MIGRATION
-- =============================================================================
