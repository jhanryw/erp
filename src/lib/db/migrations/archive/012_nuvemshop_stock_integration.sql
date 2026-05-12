-- =============================================================================
-- 012_nuvemshop_stock_integration.sql
-- Integração ERP ↔ Nuvemshop: mapeamento de variações, baixa de estoque,
-- rastreabilidade de movimentações por canal.
--
-- EXECUTAR APÓS 010, 011.
-- Idempotente: IF NOT EXISTS / CREATE OR REPLACE / ADD COLUMN IF NOT EXISTS.
-- =============================================================================

-- =============================================================================
-- 1. EVOLUIR produto_map — suporte a variação + SKU externo
-- =============================================================================

ALTER TABLE public.produto_map
  ADD COLUMN IF NOT EXISTS product_variation_id INT
    REFERENCES public.product_variations(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS external_variant_id  TEXT,
  ADD COLUMN IF NOT EXISTS external_sku         TEXT;

-- Índice único parcial: um variant_id externo por source
-- Permite múltiplas linhas sem variant (produto-nível) sem conflito
CREATE UNIQUE INDEX IF NOT EXISTS uq_produto_map_variant
  ON public.produto_map (source, external_variant_id)
  WHERE external_variant_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_produto_map_variant_id
  ON public.produto_map (external_variant_id)
  WHERE external_variant_id IS NOT NULL;

-- =============================================================================
-- 2. pedidos — flag de processamento de estoque
-- =============================================================================

ALTER TABLE public.pedidos
  ADD COLUMN IF NOT EXISTS stock_processed BOOLEAN NOT NULL DEFAULT FALSE;

-- =============================================================================
-- 3. pedidos_itens — campos de mapeamento para produto interno
-- =============================================================================

ALTER TABLE public.pedidos_itens
  ADD COLUMN IF NOT EXISTS product_variation_id BIGINT,
  ADD COLUMN IF NOT EXISTS mapped               BOOLEAN NOT NULL DEFAULT FALSE;

CREATE INDEX IF NOT EXISTS idx_pedidos_itens_pv
  ON public.pedidos_itens (product_variation_id)
  WHERE product_variation_id IS NOT NULL;

-- =============================================================================
-- 4. estoque_movimentacoes — log de movimentações por canal
-- Tracking simples e desnormalizado para rastreabilidade de origem.
-- Não substitui stock_movements (que é o ledger principal do ERP).
-- =============================================================================

CREATE TABLE IF NOT EXISTS public.estoque_movimentacoes (
  id                   BIGSERIAL    PRIMARY KEY,
  produto_id           BIGINT,
  product_variation_id BIGINT,
  tipo                 TEXT         NOT NULL
                         CHECK (tipo IN ('entrada','saida','ajuste','cancelamento')),
  origem               TEXT         NOT NULL
                         CHECK (origem IN ('erp','nuvemshop')),
  referencia_externa   TEXT,
  quantidade           INT          NOT NULL,
  created_at           TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_estoque_mov_pv
  ON public.estoque_movimentacoes (product_variation_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_estoque_mov_origem
  ON public.estoque_movimentacoes (origem, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_estoque_mov_ref
  ON public.estoque_movimentacoes (referencia_externa)
  WHERE referencia_externa IS NOT NULL;

-- =============================================================================
-- 5. rpc_nuvemshop_sale_deduct
-- Baixa de estoque para vendas vindas da Nuvemshop.
--
-- Diferenças vs rpc_stock_adjust:
--   - Não gera finance_entry (venda já foi registrada no canal)
--   - Não bloqueia se saldo < quantidade (venda já ocorreu externamente)
--   - Idempotente via reference_id: 'ns:{external_order_id}'
--   - created_by = NULL (operação de sistema, sem usuário humano)
-- =============================================================================

CREATE OR REPLACE FUNCTION public.rpc_nuvemshop_sale_deduct(
  p_product_variation_id INT,
  p_quantity             INT,
  p_external_order_id    TEXT
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_ref_id           TEXT;
  v_current_qty      INT     := 0;
  v_current_avg_cost NUMERIC := 0;
  v_new_qty          INT;
  v_company_id       INT;
BEGIN
  PERFORM set_config('app.stock_rpc', '1', true);

  v_ref_id := 'ns:' || p_external_order_id;

  -- Idempotência: se já existe movimento para este pedido+variação, pular
  IF EXISTS (
    SELECT 1 FROM stock_movements
    WHERE product_variation_id = p_product_variation_id
      AND reference_id         = v_ref_id
      AND type                 = 'sale'
  ) THEN
    SELECT COALESCE(quantity, 0) INTO v_current_qty
    FROM stock WHERE product_variation_id = p_product_variation_id;
    RETURN jsonb_build_object('new_quantity', v_current_qty, 'skipped', TRUE);
  END IF;

  -- Derivar company_id via product_variation → product
  SELECT p.company_id INTO v_company_id
  FROM   product_variations pv
  JOIN   products           p ON p.id = pv.product_id
  WHERE  pv.id = p_product_variation_id;

  -- Bloquear linha para evitar race condition com outras baixas simultâneas
  SELECT quantity, avg_cost
  INTO   v_current_qty, v_current_avg_cost
  FROM   stock
  WHERE  product_variation_id = p_product_variation_id
  FOR UPDATE;

  IF v_current_qty      IS NULL THEN v_current_qty      := 0; END IF;
  IF v_current_avg_cost IS NULL THEN v_current_avg_cost := 0; END IF;

  -- Não deixar negativo: venda no canal já aconteceu, ERP não bloqueia
  v_new_qty := GREATEST(0, v_current_qty - p_quantity);

  INSERT INTO stock (product_variation_id, quantity, avg_cost, last_updated)
  VALUES (p_product_variation_id, v_new_qty, v_current_avg_cost, NOW())
  ON CONFLICT (product_variation_id) DO UPDATE
    SET quantity     = v_new_qty,
        last_updated = NOW();

  -- Registrar saída no ledger principal (type='sale', sem finance_entry)
  INSERT INTO stock_movements (
    product_variation_id, product_id, type, quantity,
    previous_stock, new_stock, unit_cost, reference_id,
    notes, created_by, company_id
  )
  SELECT p_product_variation_id,
         pv.product_id,
         'sale',
         -p_quantity,
         v_current_qty,
         v_new_qty,
         v_current_avg_cost,
         v_ref_id,
         'Venda via Nuvemshop',
         NULL,
         v_company_id
  FROM   product_variations pv
  WHERE  pv.id = p_product_variation_id;

  RETURN jsonb_build_object('new_quantity', v_new_qty, 'skipped', FALSE);
END;
$$;

GRANT EXECUTE ON FUNCTION public.rpc_nuvemshop_sale_deduct TO service_role;

-- =============================================================================
-- FIM DA MIGRAÇÃO 012
-- =============================================================================
