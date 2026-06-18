-- Migration: 20260618_fix_pedidos_itens_webhook_columns.sql
-- Adiciona colunas usadas pelo webhook da Nuvemshop em pedidos_itens.
-- A tabela em produção tem apenas: id, pedido_id, external_product_id, nome, quantidade, preco.

ALTER TABLE public.pedidos_itens
  ADD COLUMN IF NOT EXISTS product_variation_id INT REFERENCES public.product_variations(id),
  ADD COLUMN IF NOT EXISTS mapped               BOOLEAN NOT NULL DEFAULT FALSE;

CREATE INDEX IF NOT EXISTS idx_pedidos_itens_pv
  ON public.pedidos_itens (product_variation_id)
  WHERE product_variation_id IS NOT NULL;
