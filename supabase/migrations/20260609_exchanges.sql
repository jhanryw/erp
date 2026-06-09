-- =============================================================================
-- Trocas (exchanges)
-- Cria as tabelas exchanges e exchange_items, vincula crédito gerado à tabela
-- cashback_transactions, e expõe a função rpc_process_exchange que processa
-- a devolução de forma atômica.
-- =============================================================================


-- -----------------------------------------------------------------------------
-- 1. Tabelas
-- -----------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS public.exchanges (
  id               serial        PRIMARY KEY,
  company_id       int           NOT NULL REFERENCES public.companies(id),
  original_sale_id int           NOT NULL REFERENCES public.sales(id),
  customer_id      int           NOT NULL REFERENCES public.customers(id),
  status           text          NOT NULL DEFAULT 'completed'
                                 CHECK (status IN ('completed', 'cancelled')),
  returned_amount  numeric(10,2) NOT NULL DEFAULT 0,
  credit_issued    numeric(10,2) NOT NULL DEFAULT 0,
  notes            text,
  created_by       uuid          REFERENCES public.users(id),
  created_at       timestamptz   NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_exchanges_sale     ON public.exchanges(original_sale_id);
CREATE INDEX IF NOT EXISTS idx_exchanges_customer ON public.exchanges(customer_id);
CREATE INDEX IF NOT EXISTS idx_exchanges_company  ON public.exchanges(company_id);


CREATE TABLE IF NOT EXISTS public.exchange_items (
  id                   serial        PRIMARY KEY,
  exchange_id          int           NOT NULL REFERENCES public.exchanges(id) ON DELETE CASCADE,
  sale_item_id         int           NOT NULL REFERENCES public.sale_items(id),
  product_variation_id int           NOT NULL REFERENCES public.product_variations(id),
  quantity_returned    int           NOT NULL CHECK (quantity_returned > 0),
  unit_price           numeric(10,2) NOT NULL,
  total_returned       numeric(10,2) NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_exchange_items_exchange  ON public.exchange_items(exchange_id);
CREATE INDEX IF NOT EXISTS idx_exchange_items_sale_item ON public.exchange_items(sale_item_id);


-- -----------------------------------------------------------------------------
-- 2. Coluna de rastreio em cashback_transactions
-- -----------------------------------------------------------------------------

ALTER TABLE public.cashback_transactions
  ADD COLUMN IF NOT EXISTS exchange_id int REFERENCES public.exchanges(id);


-- -----------------------------------------------------------------------------
-- 3. Função rpc_process_exchange
-- Valida os itens, restaura estoque, cria o registro de troca e gera o crédito
-- imediato na carteira cashback do cliente.
-- -----------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.rpc_process_exchange(
  p_company_id  int,
  p_sale_id     int,
  p_customer_id int,
  p_items       jsonb,  -- [{sale_item_id, quantity_returned}]
  p_notes       text,
  p_user_id     uuid
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_sale           record;
  v_sale_item      record;
  v_el             jsonb;
  v_qty_ret        int;
  v_already_ret    int;
  v_prev_qty       int;
  v_total_credit   numeric(10,2) := 0;
  v_exchange_id    int;
  v_total_orig_qty int;
  v_total_exch_qty int;
BEGIN
  PERFORM set_config('app.stock_rpc', '1', true);

  -- Travar e validar a venda
  SELECT id, company_id, customer_id, status
  INTO v_sale
  FROM sales
  WHERE id = p_sale_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Venda não encontrada.' USING ERRCODE = 'P0001';
  END IF;
  IF v_sale.company_id <> p_company_id THEN
    RAISE EXCEPTION 'Acesso negado.' USING ERRCODE = 'P0001';
  END IF;
  IF v_sale.customer_id <> p_customer_id THEN
    RAISE EXCEPTION 'Cliente não corresponde à venda.' USING ERRCODE = 'P0001';
  END IF;
  IF v_sale.status = 'cancelled' THEN
    RAISE EXCEPTION 'Venda cancelada não pode ser trocada.' USING ERRCODE = 'P0001';
  END IF;
  IF jsonb_array_length(p_items) = 0 THEN
    RAISE EXCEPTION 'Selecione ao menos um item para trocar.' USING ERRCODE = 'P0001';
  END IF;

  -- Validar itens e somar crédito
  FOR v_el IN SELECT * FROM jsonb_array_elements(p_items) LOOP
    v_qty_ret := (v_el->>'quantity_returned')::int;

    SELECT si.id, si.sale_id, si.quantity, si.unit_price,
           si.product_variation_id, si.unit_cost
    INTO v_sale_item
    FROM sale_items si
    WHERE si.id = (v_el->>'sale_item_id')::int
      AND si.sale_id = p_sale_id;

    IF NOT FOUND THEN
      RAISE EXCEPTION 'Item % não pertence à venda.', (v_el->>'sale_item_id')
        USING ERRCODE = 'P0001';
    END IF;
    IF v_qty_ret <= 0 THEN
      RAISE EXCEPTION 'Quantidade deve ser maior que zero.' USING ERRCODE = 'P0001';
    END IF;

    SELECT COALESCE(SUM(ei.quantity_returned), 0)
    INTO v_already_ret
    FROM exchange_items ei
    JOIN exchanges ex ON ex.id = ei.exchange_id
    WHERE ei.sale_item_id = v_sale_item.id
      AND ex.status = 'completed';

    IF v_qty_ret > (v_sale_item.quantity - v_already_ret) THEN
      RAISE EXCEPTION
        'Quantidade (%) excede o disponível para troca (%) no item %.',
        v_qty_ret, (v_sale_item.quantity - v_already_ret), v_sale_item.id
        USING ERRCODE = 'P0001';
    END IF;

    v_total_credit := v_total_credit + (v_qty_ret * v_sale_item.unit_price);
  END LOOP;

  -- Criar registro da troca
  INSERT INTO exchanges (
    company_id, original_sale_id, customer_id,
    returned_amount, credit_issued, notes, created_by
  )
  VALUES (
    p_company_id, p_sale_id, p_customer_id,
    v_total_credit, v_total_credit, p_notes, p_user_id
  )
  RETURNING id INTO v_exchange_id;

  -- Criar itens, restaurar estoque e registrar movimentação
  FOR v_el IN SELECT * FROM jsonb_array_elements(p_items) LOOP
    v_qty_ret := (v_el->>'quantity_returned')::int;

    SELECT si.id, si.quantity, si.unit_price, si.product_variation_id, si.unit_cost
    INTO v_sale_item
    FROM sale_items si
    WHERE si.id = (v_el->>'sale_item_id')::int;

    INSERT INTO exchange_items (
      exchange_id, sale_item_id, product_variation_id,
      quantity_returned, unit_price, total_returned
    )
    VALUES (
      v_exchange_id, v_sale_item.id, v_sale_item.product_variation_id,
      v_qty_ret, v_sale_item.unit_price, v_qty_ret * v_sale_item.unit_price
    );

    SELECT quantity INTO v_prev_qty
    FROM stock
    WHERE product_variation_id = v_sale_item.product_variation_id
    FOR UPDATE;

    IF v_prev_qty IS NULL THEN v_prev_qty := 0; END IF;

    INSERT INTO stock (product_variation_id, quantity, avg_cost, last_updated)
    VALUES (v_sale_item.product_variation_id, v_qty_ret, v_sale_item.unit_cost, NOW())
    ON CONFLICT (product_variation_id) DO UPDATE
      SET quantity     = stock.quantity + v_qty_ret,
          last_updated = NOW();

    -- stock_movements não tem coluna created_by
    INSERT INTO stock_movements (
      product_variation_id, product_id, type, quantity,
      previous_stock, new_stock, unit_cost, reference_id, company_id
    )
    SELECT
      v_sale_item.product_variation_id, pv.product_id,
      'return', v_qty_ret,
      v_prev_qty, v_prev_qty + v_qty_ret,
      v_sale_item.unit_cost, p_sale_id::text, p_company_id
    FROM product_variations pv
    WHERE pv.id = v_sale_item.product_variation_id;
  END LOOP;

  -- Gerar crédito imediato (entra direto no available_balance da view)
  INSERT INTO cashback_transactions (
    customer_id, company_id, sale_id,
    type, amount, status, release_date, exchange_id
  )
  VALUES (
    p_customer_id, p_company_id, p_sale_id,
    'earn', v_total_credit, 'available', CURRENT_DATE, v_exchange_id
  );

  -- Marcar venda como devolvida se todos os itens foram trocados
  SELECT SUM(quantity) INTO v_total_orig_qty
  FROM sale_items
  WHERE sale_id = p_sale_id;

  SELECT COALESCE(SUM(ei.quantity_returned), 0) INTO v_total_exch_qty
  FROM exchange_items ei
  JOIN exchanges ex ON ex.id = ei.exchange_id
  WHERE ex.original_sale_id = p_sale_id
    AND ex.status = 'completed';

  IF v_total_exch_qty >= v_total_orig_qty THEN
    UPDATE sales SET status = 'returned', updated_at = NOW()
    WHERE id = p_sale_id;
  END IF;

  RETURN jsonb_build_object(
    'exchange_id',   v_exchange_id,
    'credit_amount', v_total_credit
  );
END;
$$;


-- -----------------------------------------------------------------------------
-- 4. Permissões
-- -----------------------------------------------------------------------------

GRANT SELECT, INSERT ON public.exchanges      TO service_role, authenticated;
GRANT SELECT, INSERT ON public.exchange_items TO service_role, authenticated;

GRANT USAGE, SELECT ON SEQUENCE public.exchanges_id_seq      TO service_role, authenticated;
GRANT USAGE, SELECT ON SEQUENCE public.exchange_items_id_seq TO service_role, authenticated;

GRANT EXECUTE ON FUNCTION public.rpc_process_exchange TO service_role, authenticated;


-- -----------------------------------------------------------------------------
-- 5. RLS
-- -----------------------------------------------------------------------------

ALTER TABLE public.exchanges      ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.exchange_items ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "exchanges: service_role full access"      ON public.exchanges;
DROP POLICY IF EXISTS "exchange_items: service_role full access" ON public.exchange_items;

CREATE POLICY "exchanges: service_role full access"
  ON public.exchanges FOR ALL TO service_role
  USING (true) WITH CHECK (true);

CREATE POLICY "exchange_items: service_role full access"
  ON public.exchange_items FOR ALL TO service_role
  USING (true) WITH CHECK (true);
