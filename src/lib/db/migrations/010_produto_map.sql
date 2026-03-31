-- Mapeamento entre produtos internos do ERP e produtos externos (ex: Nuvemshop)
-- Permite idempotência no envio e base para futuras sincronizações bidirecionais

CREATE TABLE IF NOT EXISTS public.produto_map (
  id          UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  produto_id  BIGINT      NOT NULL,           -- FK para products.id (integer)
  external_id TEXT        NOT NULL,           -- ID do produto na plataforma externa
  source      TEXT        NOT NULL,           -- 'nuvemshop' | 'mercadolivre' | etc.
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  CONSTRAINT uq_produto_map UNIQUE (produto_id, source)
);

CREATE INDEX IF NOT EXISTS idx_produto_map_produto_id ON public.produto_map (produto_id);
CREATE INDEX IF NOT EXISTS idx_produto_map_source     ON public.produto_map (source);
