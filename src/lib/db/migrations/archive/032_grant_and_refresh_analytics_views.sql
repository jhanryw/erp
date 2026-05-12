-- Migration 032: Grant access to analytics materialized views + create refresh function
--
-- Problema: as views analíticas (mv_daily_sales_summary, mv_product_performance, etc.)
-- foram criadas sem GRANT para o role "authenticated", então o client do usuário
-- não conseguia ler os dados. Além disso, as views precisam ser atualizadas
-- periodicamente para refletir vendas recentes.
--
-- Este script:
--   1. Concede SELECT para authenticated e service_role em todas as views analíticas
--   2. Cria função refresh_analytics_views() para atualizar todas de uma vez
--   3. Faz a atualização inicial imediata (popula com dados atuais)
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 1. GRANT SELECT em todas as materialized views analíticas
-- -----------------------------------------------------------------------------
GRANT SELECT ON mv_daily_sales_summary   TO authenticated, service_role;
GRANT SELECT ON mv_product_performance   TO authenticated, service_role;
GRANT SELECT ON mv_abc_by_revenue        TO authenticated, service_role;
GRANT SELECT ON mv_abc_by_profit         TO authenticated, service_role;
GRANT SELECT ON mv_abc_by_volume         TO authenticated, service_role;
GRANT SELECT ON mv_customer_rfm          TO authenticated, service_role;
GRANT SELECT ON mv_monthly_financial     TO authenticated, service_role;
GRANT SELECT ON mv_color_performance     TO authenticated, service_role;
GRANT SELECT ON mv_supplier_performance  TO authenticated, service_role;

-- -----------------------------------------------------------------------------
-- 2. Função de atualização — chamada pela API /api/admin/refresh-views
--    e pode ser agendada via pg_cron se disponível no plano Supabase
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION refresh_analytics_views()
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  started_at TIMESTAMPTZ := NOW();
BEGIN
  REFRESH MATERIALIZED VIEW CONCURRENTLY mv_daily_sales_summary;
  REFRESH MATERIALIZED VIEW CONCURRENTLY mv_product_performance;
  -- Estas dependem de mv_product_performance, então devem vir depois
  REFRESH MATERIALIZED VIEW CONCURRENTLY mv_abc_by_revenue;
  REFRESH MATERIALIZED VIEW CONCURRENTLY mv_abc_by_profit;
  REFRESH MATERIALIZED VIEW CONCURRENTLY mv_abc_by_volume;
  REFRESH MATERIALIZED VIEW CONCURRENTLY mv_customer_rfm;
  REFRESH MATERIALIZED VIEW CONCURRENTLY mv_monthly_financial;
  REFRESH MATERIALIZED VIEW CONCURRENTLY mv_color_performance;
  REFRESH MATERIALIZED VIEW CONCURRENTLY mv_supplier_performance;

  RETURN jsonb_build_object(
    'ok', true,
    'refreshed_at', NOW(),
    'duration_ms', EXTRACT(EPOCH FROM (NOW() - started_at)) * 1000
  );
EXCEPTION
  WHEN OTHERS THEN
    RETURN jsonb_build_object(
      'ok', false,
      'error', SQLERRM,
      'refreshed_at', NOW()
    );
END;
$$;

-- Garante que apenas service_role pode chamar a função
REVOKE ALL ON FUNCTION refresh_analytics_views() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION refresh_analytics_views() TO service_role;

-- -----------------------------------------------------------------------------
-- 3. Atualização inicial
--    ATENÇÃO: REFRESH MATERIALIZED VIEW CONCURRENTLY não pode rodar dentro
--    de uma transação (e o Supabase envolve cada migration em uma transação).
--    Execute manualmente via SQL Editor após aplicar a migration:
--
--      SELECT refresh_analytics_views();
--
--    Ou acesse: POST /api/admin/refresh-views
-- -----------------------------------------------------------------------------

-- -----------------------------------------------------------------------------
-- 4. Agendamento via pg_cron (habilite se pg_cron estiver disponível)
--    Vá em: Dashboard Supabase > Database > Extensions > pg_cron
-- -----------------------------------------------------------------------------
-- SELECT cron.schedule('refresh-daily-sales',   '0 * * * *',   'SELECT refresh_analytics_views()');
-- SELECT cron.schedule('refresh-analytics',      '0 */6 * * *', 'SELECT refresh_analytics_views()');
