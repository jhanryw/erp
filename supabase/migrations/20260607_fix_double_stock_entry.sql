-- =============================================================================
-- 20260607_fix_double_stock_entry.sql
--
-- PROBLEMA IDENTIFICADO:
--   A migração 033_fix_stock_consistency_and_add_lot_sync_trigger criou o
--   trigger trg_sync_stock_lots em stock_lots (AFTER INSERT OR UPDATE OR DELETE).
--   Quando rpc_stock_entry executa, a ordem dentro da transação é:
--
--     1. INSERT stock_lots           → trigger dispara imediatamente e já seta
--                                      stock.quantity = SUM(quantity_remaining)
--     2. RPC lê v_prev_qty de stock  → lê o valor JÁ atualizado pelo trigger
--     3. RPC faz UPSERT stock com v_prev_qty + qty → soma o qty UMA VEZ A MAIS
--
--   Resultado: para cada entrada de qty unidades, o estoque cresce 2×qty mas
--   stock_movements registra apenas +qty.
--   Confirma o padrão da auditoria: stock.quantity = 2 × SUM(movements).
--
-- CORREÇÃO:
--   1. Remover o trigger (causa raiz).
--   2. Corrigir saldos: stock.quantity = SUM(stock_movements.quantity) por
--      variação — o ledger de movimentos é a fonte de verdade (registrou o
--      valor real de cada operação, sem a duplicação).
--
-- Variações com divergência negativa (stock < movements) são conservadas —
-- indicariam um bug diferente e precisam de investigação manual.
--
-- Idempotente: DROP IF EXISTS + UPDATE condicional por divergência.
-- =============================================================================

-- ─── 1. Remover o trigger que causava contagem dupla ─────────────────────────

DROP TRIGGER IF EXISTS trg_sync_stock_lots ON public.stock_lots;

-- Função usada exclusivamente por esse trigger; pode ser removida com segurança.
DROP FUNCTION IF EXISTS public.sync_stock_from_lots();

-- ─── 2. Corrigir saldos duplicados ───────────────────────────────────────────
--
-- O ledger stock_movements registrou cada operação com o valor real (qty que
-- o usuário informou), sem a duplicação causada pelo trigger. Por isso:
--
--   SUM(stock_movements.quantity por variação) = saldo físico correto
--
-- Ajustamos apenas variações onde:
--   a) stock.quantity > movements_sum  (excesso gerado pelo bug duplo)
--   b) movements_sum >= 0             (ledger saudável; ledger negativo é
--                                      inconsistência separada — não tocamos)

DO $$
BEGIN
  PERFORM set_config('app.stock_rpc', '1', true);

  UPDATE public.stock s
  SET
    quantity     = mv.movements_sum,
    last_updated = NOW()
  FROM (
    SELECT
      product_variation_id,
      SUM(quantity)::int AS movements_sum
    FROM public.stock_movements
    GROUP BY product_variation_id
  ) mv
  WHERE s.product_variation_id = mv.product_variation_id
    AND s.quantity > mv.movements_sum   -- saldo inflado pelo bug
    AND mv.movements_sum >= 0;          -- evita violar stock_non_negative
END;
$$;
