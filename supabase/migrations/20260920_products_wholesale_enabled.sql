-- =============================================================================
-- 20260920_products_wholesale_enabled.sql
--
-- Catálogo de atacado — configuração EXPLÍCITA de canal por produto.
--
-- Até aqui não existia nenhum controle de "este produto participa do
-- atacado": qualquer produto ativo com wholesale_price e estoque aparecia
-- (e produto sem wholesale_price ficava escondido só como efeito colateral).
-- Preço de atacado e participação no canal são conceitos distintos — esta
-- coluna é só o segundo.
--
-- Decisão de schema: coluna direta em `products` (não uma tabela
-- product_channel_settings). Hoje só o atacado precisa desse controle, a
-- Nuvemshop tem lógica própria (produto_map) e o PDV usa products.active.
-- Uma coluna booleana é aditiva, sem JOIN e sem abstração hipotética; se um
-- segundo canal precisar de configuração própria, evolui-se então.
--
-- SEGURANÇA DE ROLLOUT: DEFAULT false e NENHUM backfill. Depois desta
-- migration NENHUM produto fica visível no atacado até ser habilitado
-- manualmente (UPDATE pontual ou, futuramente, pela tela do ERP). Nenhuma
-- linha existente é atualizada. ADD COLUMN com DEFAULT constante é
-- metadata-only no Postgres >= 11 (sem reescrita da tabela).
-- =============================================================================

ALTER TABLE public.products
  ADD COLUMN IF NOT EXISTS wholesale_enabled BOOLEAN NOT NULL DEFAULT false;

COMMENT ON COLUMN public.products.wholesale_enabled IS
  'Produto participa do catálogo público de atacado. Independente de wholesale_price (preço) e de products.active (PDV/todos os canais). DEFAULT false — habilitação é sempre explícita.';

-- Índice parcial pro filtro do catálogo (company_id + ativo + habilitado). O
-- conjunto habilitado é pequeno e curado — o índice parcial fica minúsculo.
CREATE INDEX IF NOT EXISTS idx_products_company_wholesale_enabled
  ON public.products (company_id)
  WHERE wholesale_enabled = true AND active = true;

-- =============================================================================
-- Smoke tests (somente leitura)
-- =============================================================================
-- SELECT count(*) FROM public.products WHERE wholesale_enabled;   -- Esperado: 0 logo após a migration

-- =============================================================================
-- ROLLBACK
-- =============================================================================
/*
DROP INDEX IF EXISTS public.idx_products_company_wholesale_enabled;
ALTER TABLE public.products DROP COLUMN IF EXISTS wholesale_enabled;
*/
