-- Fase Fiscal 5C — fundação de endereço/snapshot (parte 3/4).
--
-- Por quê: `unit_price` hoje é sobrescrito com o preço negociado sem
-- nenhum rastro do preço de tabela/original (achado confirmado por
-- auditoria — grep exaustivo em `rpc_create_sale`/`sale_items`, zero
-- referência a `products.base_price`/`product_variations.price_override`
-- no caminho de criação de venda). Proposta aprovada em
-- `docs/fiscal-fase5b-arquitetura-revisada.md` §3/§9.
--
-- `list_price_snapshot` é puramente informativo — nunca entra em nenhum
-- total (`subtotal`/`total_price`/`products_total`), só serve para
-- reconstrução histórica ("o produto custava X quando foi vendido por Y").
--
-- `surcharge_amount` é o campo simétrico a `discount_amount`, hoje ausente
-- em `sale_items` (só existe em `sales`, nível de pedido) — permite
-- registrar acréscimo individual por item sem sobrescrever `unit_price`.
--
-- Idempotente: ADD COLUMN IF NOT EXISTS. Reversível: DROP COLUMN das duas
-- colunas novas. Nenhuma coluna existente é removida, renomeada, nem tem
-- seu tipo alterado. `total_price` continua sendo uma coluna normal
-- (calculada pela aplicação/RPC, não GERADA pelo banco) — esta migration
-- não mexe nela; o RPC que passa a somar `surcharge_amount` na fórmula é
-- objeto de uma migration separada (ver
-- 20260828_rpc_create_sale_pricing_and_products_total.sql).

ALTER TABLE public.sale_items
  ADD COLUMN IF NOT EXISTS list_price_snapshot NUMERIC(10,2),
  ADD COLUMN IF NOT EXISTS surcharge_amount NUMERIC(10,2) NOT NULL DEFAULT 0;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'sale_items_surcharge_non_negative'
  ) THEN
    ALTER TABLE public.sale_items
      ADD CONSTRAINT sale_items_surcharge_non_negative
      CHECK (surcharge_amount >= 0);
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'sale_items_list_price_non_negative'
  ) THEN
    ALTER TABLE public.sale_items
      ADD CONSTRAINT sale_items_list_price_non_negative
      CHECK (list_price_snapshot IS NULL OR list_price_snapshot >= 0);
  END IF;
END $$;

COMMENT ON COLUMN public.sale_items.list_price_snapshot IS
  'Preço de tabela do produto (base_price/price_override) no momento da venda — snapshot informativo, NUNCA lido de products/product_variations depois, NUNCA usado em nenhum cálculo de total. Pode ser NULL para vendas anteriores a esta migration ou origens que não o capturam ainda (ex.: Nuvemshop).';
COMMENT ON COLUMN public.sale_items.surcharge_amount IS
  'Acréscimo individual deste item, simétrico a discount_amount. total_price = (unit_price*quantity) - discount_amount + surcharge_amount.';
