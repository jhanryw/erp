-- Fase 1: campos fiscais básicos em products
-- NCM (8 dígitos), CEST (00.000.00), origem (0-8 ICMS), unidade_med (default 'UN')
-- Não toca em NF-e, XML, SEFAZ, tax_rules, views ou RPCs.

ALTER TABLE public.products
  ADD COLUMN IF NOT EXISTS ncm         text,
  ADD COLUMN IF NOT EXISTS cest        text,
  ADD COLUMN IF NOT EXISTS origem      smallint,
  ADD COLUMN IF NOT EXISTS unidade_med text NOT NULL DEFAULT 'UN';

COMMENT ON COLUMN public.products.ncm         IS 'Nomenclatura Comum do Mercosul (8 dígitos numéricos)';
COMMENT ON COLUMN public.products.cest        IS 'Código Especificador da Substituição Tributária (formato 00.000.00)';
COMMENT ON COLUMN public.products.origem      IS 'Origem da mercadoria conforme tabela ICMS (0=nacional, 1..8=importado/misto)';
COMMENT ON COLUMN public.products.unidade_med IS 'Unidade de medida comercial (UN, PAR, KG, M, M2, L, CX, etc.)';
