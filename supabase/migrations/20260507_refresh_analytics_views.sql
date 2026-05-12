-- =============================================================================
-- Função: refresh_analytics_views
-- Atualiza todas as materialized views analíticas na ordem correta.
-- mv_product_performance deve ser primeiro pois mv_abc_* dependem dela.
-- Retorna JSON com status de cada view e duração total.
-- =============================================================================

CREATE OR REPLACE FUNCTION refresh_analytics_views()
RETURNS JSON
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_start   TIMESTAMPTZ := clock_timestamp();
  v_results JSON;
BEGIN
  -- 1. Base: performance de produtos (abc_* dependem desta)
  REFRESH MATERIALIZED VIEW CONCURRENTLY mv_product_performance;

  -- 2. Curvas ABC (dependem de mv_product_performance)
  REFRESH MATERIALIZED VIEW CONCURRENTLY mv_abc_by_revenue;
  REFRESH MATERIALIZED VIEW CONCURRENTLY mv_abc_by_profit;
  REFRESH MATERIALIZED VIEW CONCURRENTLY mv_abc_by_volume;

  -- 3. Views independentes
  REFRESH MATERIALIZED VIEW CONCURRENTLY mv_stock_status;
  REFRESH MATERIALIZED VIEW CONCURRENTLY mv_color_performance;
  REFRESH MATERIALIZED VIEW CONCURRENTLY mv_supplier_performance;
  REFRESH MATERIALIZED VIEW CONCURRENTLY mv_customer_rfm;
  REFRESH MATERIALIZED VIEW CONCURRENTLY mv_daily_sales_summary;
  REFRESH MATERIALIZED VIEW CONCURRENTLY mv_monthly_financial;

  v_results := json_build_object(
    'ok', true,
    'duration_ms', EXTRACT(EPOCH FROM (clock_timestamp() - v_start)) * 1000,
    'refreshed_at', clock_timestamp()
  );

  RETURN v_results;
END;
$$;

-- Permite que authenticated users (via service_role no server) chamem a função
GRANT EXECUTE ON FUNCTION refresh_analytics_views() TO service_role;
