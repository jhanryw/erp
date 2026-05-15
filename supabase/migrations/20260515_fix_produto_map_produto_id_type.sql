-- Corrige o tipo de produto_map.produto_id de uuid → bigint.
-- A tabela está vazia, então é seguro dropar e recriar a coluna.
-- products.id é BIGINT/BIGSERIAL; produto_id deve corresponder.

ALTER TABLE public.produto_map
  DROP COLUMN IF EXISTS produto_id;

ALTER TABLE public.produto_map
  ADD COLUMN produto_id BIGINT;

-- Recriar constraint de unicidade (produto_id, source) se não existir
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'uq_produto_map'
  ) THEN
    ALTER TABLE public.produto_map
      ADD CONSTRAINT uq_produto_map UNIQUE (produto_id, source);
  END IF;
END
$$;

CREATE INDEX IF NOT EXISTS idx_produto_map_produto_id
  ON public.produto_map (produto_id);
