-- =============================================================================
-- Migration 20260521: Monitor de divergência de estoque
--
-- PROBLEMA: stock.quantity pode divergir de SUM(stock_movements.quantity)
--   - via SET app.stock_rpc='1' manual no SQL editor
--   - via bug futuro em qualquer RPC
--   - via seed/import direto
--
-- SOLUÇÃO: VIEW vw_stock_divergence para auditoria contínua.
--   Consulta deve retornar ZERO linhas em operação normal.
--   Cron job ou alerta externo deve monitorar esta view.
--
-- REGRA: stock_movements é o ledger oficial. Se divergir, a correção é
--   inserir um movimento de reconciliação, NUNCA alterar stock diretamente.
-- =============================================================================

-- =============================================================================
-- VIEW: divergência entre stock.quantity e ledger de movimentos
-- =============================================================================

CREATE OR REPLACE VIEW public.vw_stock_divergence AS
SELECT
  s.product_variation_id,
  p.id                                          AS product_id,
  p.name                                        AS product_name,
  pv.sku_variation,
  p.company_id,
  s.quantity                                    AS stock_qty,
  COALESCE(SUM(sm.quantity), 0)::int            AS movements_sum,
  (s.quantity - COALESCE(SUM(sm.quantity), 0))  AS divergence,
  s.last_updated
FROM public.stock s
JOIN public.product_variations pv ON pv.id = s.product_variation_id
JOIN public.products            p  ON p.id  = pv.product_id
LEFT JOIN public.stock_movements sm
       ON sm.product_variation_id = s.product_variation_id
GROUP BY
  s.product_variation_id, p.id, p.name, pv.sku_variation, p.company_id,
  s.quantity, s.last_updated
HAVING s.quantity != COALESCE(SUM(sm.quantity), 0);

GRANT SELECT ON public.vw_stock_divergence TO authenticated, service_role;

-- =============================================================================
-- FUNÇÃO: reconciliar divergências (usar apenas após inventário físico)
--
-- Insere movimentos 'reconcile' para as variações com divergência positiva.
-- Divergências negativas indicam BUG (mais movimentos que estoque físico) —
-- são logadas mas NÃO corrigidas automaticamente; exigem investigação manual.
-- =============================================================================

CREATE OR REPLACE FUNCTION public.rpc_reconcile_stock_divergence(
  p_reason          text    DEFAULT 'reconcile-manual',
  p_system_user_id  uuid    DEFAULT NULL,
  p_dry_run         boolean DEFAULT true
)
RETURNS TABLE (
  product_variation_id  int,
  product_name          text,
  sku_variation         text,
  stock_qty             int,
  movements_sum         int,
  divergence            int,
  action                text
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF p_dry_run THEN
    -- Apenas retorna o relatório, sem alterar nada
    RETURN QUERY
    SELECT
      d.product_variation_id,
      d.product_name,
      d.sku_variation,
      d.stock_qty::int,
      d.movements_sum::int,
      d.divergence::int,
      CASE
        WHEN d.divergence > 0 THEN 'INSERIR movimento +' || d.divergence
        ELSE 'BUG: divergência negativa — investigar manualmente'
      END AS action
    FROM public.vw_stock_divergence d
    ORDER BY ABS(d.divergence) DESC;
    RETURN;
  END IF;

  -- Modo real: inserir movimentos de reconciliação para divergências positivas
  INSERT INTO public.stock_movements (
    product_variation_id, product_id, type, quantity,
    previous_stock, new_stock, unit_cost, reference_id, company_id
  )
  SELECT
    d.product_variation_id,
    d.product_id,
    'initial',
    d.divergence,
    d.movements_sum,
    d.stock_qty,
    COALESCE(s.avg_cost, 0),
    p_reason || '-' || TO_CHAR(NOW(), 'YYYYMMDD'),
    d.company_id
  FROM public.vw_stock_divergence d
  JOIN public.stock s ON s.product_variation_id = d.product_variation_id
  WHERE d.divergence > 0;

  -- Retornar relatório pós-correção
  RETURN QUERY
  SELECT
    d.product_variation_id,
    d.product_name,
    d.sku_variation,
    d.stock_qty::int,
    d.movements_sum::int,
    d.divergence::int,
    CASE
      WHEN d.divergence > 0 THEN 'CORRIGIDO: movimento inserido'
      ELSE 'PENDENTE: divergência negativa — investigar manualmente'
    END AS action
  FROM public.vw_stock_divergence d
  ORDER BY ABS(d.divergence) DESC;
END;
$$;

-- =============================================================================
-- VIEW: resumo de saúde do estoque (para dashboard de monitoramento)
-- =============================================================================

CREATE OR REPLACE VIEW public.vw_stock_health AS
SELECT
  (SELECT COUNT(*) FROM public.stock)                              AS total_skus,
  (SELECT COUNT(*) FROM public.stock WHERE quantity = 0)          AS zero_stock_skus,
  (SELECT COUNT(*) FROM public.stock WHERE quantity > 0
     AND quantity <= 3)                                            AS low_stock_skus,
  (SELECT COUNT(*) FROM public.vw_stock_divergence)               AS divergent_skus,
  (SELECT COALESCE(SUM(ABS(divergence)), 0)
     FROM public.vw_stock_divergence)                             AS total_divergence_units,
  NOW()                                                            AS checked_at;

GRANT SELECT ON public.vw_stock_health TO authenticated, service_role;

-- =============================================================================
-- FIM DA MIGRAÇÃO
-- =============================================================================
