-- =============================================================================
-- 20260611_create_analytics_views.sql
--
-- Cria todas as materialized views analíticas que as páginas /inteligencia
-- dependem, caso não existam. Idempotente (IF NOT EXISTS em tudo).
-- Faz o primeiro REFRESH sem CONCURRENTLY para funcionar mesmo em views vazias.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- Tipos ENUM necessários (idempotente)
-- -----------------------------------------------------------------------------
DO $$ BEGIN
  CREATE TYPE abc_curve AS ENUM ('A', 'B', 'C');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  CREATE TYPE rfm_segment AS ENUM (
    'champions', 'loyal', 'potential_loyal', 'new_customers',
    'promising', 'at_risk', 'cant_lose', 'hibernating', 'lost'
  );
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- -----------------------------------------------------------------------------
-- mv_product_performance  (base para ABC — criar primeiro)
-- -----------------------------------------------------------------------------
CREATE MATERIALIZED VIEW IF NOT EXISTS mv_product_performance AS
SELECT
  p.id                        AS product_id,
  p.name                      AS product_name,
  p.sku,
  p.category_id,
  p.supplier_id,
  p.base_cost,
  p.base_price,
  p.margin_pct,
  COALESCE(SUM(si.quantity), 0)                AS total_units_sold,
  COALESCE(SUM(si.total_price), 0)             AS total_revenue,
  COALESCE(SUM(si.gross_profit), 0)            AS total_gross_profit,
  COALESCE(SUM(si.quantity * si.unit_cost), 0) AS total_cost,
  AVG(si.unit_price)                           AS avg_selling_price,
  ROUND(
    CASE WHEN COALESCE(SUM(si.total_price), 0) > 0
    THEN COALESCE(SUM(si.gross_profit), 0) / SUM(si.total_price) * 100
    ELSE 0 END, 2
  )                                            AS realized_margin_pct,
  MIN(s.sale_date)                             AS first_sale_date,
  MAX(s.sale_date)                             AS last_sale_date
FROM products p
JOIN product_variations pv ON pv.product_id = p.id
LEFT JOIN sale_items si ON si.product_variation_id = pv.id
LEFT JOIN sales s ON s.id = si.sale_id AND s.status NOT IN ('cancelled', 'returned')
GROUP BY p.id, p.name, p.sku, p.category_id, p.supplier_id, p.base_cost, p.base_price, p.margin_pct;

CREATE UNIQUE INDEX IF NOT EXISTS mv_product_performance_pkey ON mv_product_performance(product_id);

-- -----------------------------------------------------------------------------
-- mv_abc_by_revenue
-- -----------------------------------------------------------------------------
CREATE MATERIALIZED VIEW IF NOT EXISTS mv_abc_by_revenue AS
WITH ranked AS (
  SELECT
    product_id,
    total_revenue,
    SUM(total_revenue) OVER ()                                                       AS grand_total,
    SUM(total_revenue) OVER (ORDER BY total_revenue DESC ROWS UNBOUNDED PRECEDING)   AS cumulative_revenue
  FROM mv_product_performance
  WHERE total_revenue > 0
),
pct AS (
  SELECT
    product_id,
    total_revenue,
    ROUND(total_revenue / grand_total * 100, 2) AS revenue_pct,
    ROUND(cumulative_revenue / grand_total * 100, 2) AS cumulative_pct
  FROM ranked
)
SELECT
  product_id,
  total_revenue,
  revenue_pct,
  cumulative_pct,
  CASE
    WHEN cumulative_pct <= 80 THEN 'A'
    WHEN cumulative_pct <= 95 THEN 'B'
    ELSE 'C'
  END::abc_curve AS abc_class
FROM pct;

CREATE UNIQUE INDEX IF NOT EXISTS mv_abc_by_revenue_pkey ON mv_abc_by_revenue(product_id);

-- -----------------------------------------------------------------------------
-- mv_abc_by_profit
-- -----------------------------------------------------------------------------
CREATE MATERIALIZED VIEW IF NOT EXISTS mv_abc_by_profit AS
WITH ranked AS (
  SELECT
    product_id,
    total_gross_profit,
    SUM(total_gross_profit) OVER ()                                                         AS grand_total,
    SUM(total_gross_profit) OVER (ORDER BY total_gross_profit DESC ROWS UNBOUNDED PRECEDING) AS cumulative_profit
  FROM mv_product_performance
  WHERE total_gross_profit > 0
),
pct AS (
  SELECT
    product_id,
    total_gross_profit,
    ROUND(total_gross_profit / grand_total * 100, 2) AS profit_pct,
    ROUND(cumulative_profit / grand_total * 100, 2)  AS cumulative_pct
  FROM ranked
)
SELECT
  product_id,
  total_gross_profit,
  profit_pct,
  cumulative_pct,
  CASE
    WHEN cumulative_pct <= 80 THEN 'A'
    WHEN cumulative_pct <= 95 THEN 'B'
    ELSE 'C'
  END::abc_curve AS abc_class
FROM pct;

CREATE UNIQUE INDEX IF NOT EXISTS mv_abc_by_profit_pkey ON mv_abc_by_profit(product_id);

-- -----------------------------------------------------------------------------
-- mv_abc_by_volume
-- -----------------------------------------------------------------------------
CREATE MATERIALIZED VIEW IF NOT EXISTS mv_abc_by_volume AS
WITH ranked AS (
  SELECT
    product_id,
    total_units_sold,
    SUM(total_units_sold) OVER ()                                                         AS grand_total,
    SUM(total_units_sold) OVER (ORDER BY total_units_sold DESC ROWS UNBOUNDED PRECEDING)  AS cumulative_units
  FROM mv_product_performance
  WHERE total_units_sold > 0
),
pct AS (
  SELECT
    product_id,
    total_units_sold,
    ROUND(total_units_sold::NUMERIC / grand_total * 100, 2) AS volume_pct,
    ROUND(cumulative_units::NUMERIC / grand_total * 100, 2) AS cumulative_pct
  FROM ranked
)
SELECT
  product_id,
  total_units_sold,
  volume_pct,
  cumulative_pct,
  CASE
    WHEN cumulative_pct <= 80 THEN 'A'
    WHEN cumulative_pct <= 95 THEN 'B'
    ELSE 'C'
  END::abc_curve AS abc_class
FROM pct;

CREATE UNIQUE INDEX IF NOT EXISTS mv_abc_by_volume_pkey ON mv_abc_by_volume(product_id);

-- -----------------------------------------------------------------------------
-- mv_stock_status
-- -----------------------------------------------------------------------------
CREATE MATERIALIZED VIEW IF NOT EXISTS mv_stock_status AS
SELECT
  s.product_variation_id,
  p.id                              AS product_id,
  p.name                            AS product_name,
  p.sku,
  s.quantity                        AS current_qty,
  s.avg_cost,
  ROUND(s.quantity * s.avg_cost, 2) AS stock_value_at_cost,
  ROUND(s.quantity * COALESCE(pv.price_override, p.base_price), 2) AS stock_value_at_price,
  p.base_price,
  p.margin_pct,
  (SELECT MAX(sl.entry_date) FROM stock_lots sl
   WHERE sl.product_variation_id = s.product_variation_id) AS last_entry_date,
  (SELECT MAX(s2.sale_date) FROM sales s2
   JOIN sale_items si2 ON si2.sale_id = s2.id
   WHERE si2.product_variation_id = s.product_variation_id
   AND s2.status NOT IN ('cancelled', 'returned')) AS last_sale_date
FROM stock s
JOIN product_variations pv ON pv.id = s.product_variation_id
JOIN products p ON p.id = pv.product_id;

CREATE UNIQUE INDEX IF NOT EXISTS mv_stock_status_pkey ON mv_stock_status(product_variation_id);

-- -----------------------------------------------------------------------------
-- mv_customer_rfm
-- -----------------------------------------------------------------------------
CREATE MATERIALIZED VIEW IF NOT EXISTS mv_customer_rfm AS
WITH base AS (
  SELECT
    c.id AS customer_id,
    COALESCE(CURRENT_DATE - MAX(s.sale_date), 9999) AS days_since_last_purchase,
    COUNT(DISTINCT s.id)                              AS purchase_count,
    COALESCE(SUM(s.total), 0)                         AS total_spent
  FROM customers c
  LEFT JOIN sales s ON s.customer_id = c.id
    AND s.status NOT IN ('cancelled', 'returned')
  GROUP BY c.id
),
scored AS (
  SELECT
    customer_id,
    days_since_last_purchase,
    purchase_count,
    total_spent,
    NTILE(5) OVER (ORDER BY days_since_last_purchase ASC)  AS r_score,
    NTILE(5) OVER (ORDER BY purchase_count DESC)           AS f_score,
    NTILE(5) OVER (ORDER BY total_spent DESC)              AS m_score
  FROM base
  WHERE total_spent > 0
)
SELECT
  customer_id,
  days_since_last_purchase,
  purchase_count,
  total_spent,
  r_score,
  f_score,
  m_score,
  (r_score + f_score + m_score) AS rfm_total,
  CASE
    WHEN r_score >= 4 AND f_score >= 4 AND m_score >= 4 THEN 'champions'
    WHEN f_score >= 4 AND m_score >= 3                  THEN 'loyal'
    WHEN r_score >= 3 AND f_score >= 2                  THEN 'potential_loyal'
    WHEN r_score >= 4 AND f_score <= 2                  THEN 'new_customers'
    WHEN r_score = 3  AND f_score <= 2                  THEN 'promising'
    WHEN r_score <= 2 AND f_score >= 3 AND m_score >= 3 THEN 'at_risk'
    WHEN r_score <= 2 AND f_score >= 4 AND m_score >= 4 THEN 'cant_lose'
    WHEN r_score <= 2 AND f_score <= 2 AND m_score <= 2 THEN 'hibernating'
    ELSE 'lost'
  END::rfm_segment AS segment
FROM scored;

CREATE UNIQUE INDEX IF NOT EXISTS mv_customer_rfm_pkey ON mv_customer_rfm(customer_id);

-- -----------------------------------------------------------------------------
-- mv_daily_sales_summary
-- -----------------------------------------------------------------------------
CREATE MATERIALIZED VIEW IF NOT EXISTS mv_daily_sales_summary AS
SELECT
  s.sale_date,
  COUNT(DISTINCT s.id)                                                   AS total_orders,
  COUNT(DISTINCT s.customer_id)                                          AS unique_customers,
  SUM(s.total)                                                           AS gross_revenue,
  SUM(s.discount_amount)                                                 AS total_discounts,
  SUM(s.cashback_used)                                                   AS total_cashback_used,
  SUM(s.shipping_charged)                                                AS total_shipping_charged,
  SUM(si.gross_profit)                                                   AS gross_profit,
  AVG(s.total)                                                           AS avg_ticket,
  COUNT(DISTINCT s.id) FILTER (WHERE s.status = 'cancelled')            AS cancelled_orders
FROM sales s
JOIN sale_items si ON si.sale_id = s.id
WHERE s.status NOT IN ('cancelled', 'returned')
GROUP BY s.sale_date;

CREATE UNIQUE INDEX IF NOT EXISTS mv_daily_sales_summary_pkey ON mv_daily_sales_summary(sale_date);

-- -----------------------------------------------------------------------------
-- mv_monthly_financial
-- -----------------------------------------------------------------------------
CREATE MATERIALIZED VIEW IF NOT EXISTS mv_monthly_financial AS
SELECT
  DATE_TRUNC('month', reference_date)::DATE   AS month,
  SUM(CASE WHEN type = 'income'  THEN amount ELSE 0 END) AS total_income,
  SUM(CASE WHEN type = 'expense' THEN amount ELSE 0 END) AS total_expenses,
  SUM(CASE WHEN type = 'income'  THEN amount
           WHEN type = 'expense' THEN -amount ELSE 0 END) AS net_result,
  SUM(CASE WHEN category = 'sale'           THEN amount ELSE 0 END) AS revenue_sales,
  SUM(CASE WHEN category = 'other_income'   THEN amount ELSE 0 END) AS revenue_other,
  SUM(CASE WHEN category = 'stock_purchase' THEN amount ELSE 0 END) AS exp_stock,
  SUM(CASE WHEN category = 'marketing'      THEN amount ELSE 0 END) AS exp_marketing,
  SUM(CASE WHEN category = 'rent'           THEN amount ELSE 0 END) AS exp_rent,
  SUM(CASE WHEN category = 'salaries'       THEN amount ELSE 0 END) AS exp_salaries,
  SUM(CASE WHEN category = 'freight_cost'   THEN amount ELSE 0 END) AS exp_freight,
  SUM(CASE WHEN category = 'taxes'          THEN amount ELSE 0 END) AS exp_taxes,
  SUM(CASE WHEN category = 'operational'    THEN amount ELSE 0 END) AS exp_operational,
  SUM(CASE WHEN category = 'other_expense'  THEN amount ELSE 0 END) AS exp_other
FROM finance_entries
GROUP BY DATE_TRUNC('month', reference_date);

CREATE UNIQUE INDEX IF NOT EXISTS mv_monthly_financial_pkey ON mv_monthly_financial(month);

-- -----------------------------------------------------------------------------
-- mv_color_performance
-- -----------------------------------------------------------------------------
CREATE MATERIALIZED VIEW IF NOT EXISTS mv_color_performance AS
SELECT
  vv.value                          AS color_name,
  COUNT(DISTINCT si.id)             AS total_items_sold,
  SUM(si.quantity)                  AS total_units_sold,
  SUM(si.total_price)               AS total_revenue,
  SUM(si.gross_profit)              AS total_gross_profit,
  AVG(si.unit_price)                AS avg_price,
  AVG(s.total / NULLIF(
    (SELECT COUNT(*) FROM sale_items si2 WHERE si2.sale_id = s.id), 0
  ))                                AS avg_ticket_contribution
FROM sale_items si
JOIN sales s ON s.id = si.sale_id AND s.status NOT IN ('cancelled', 'returned')
JOIN product_variation_attributes pva ON pva.product_variation_id = si.product_variation_id
JOIN variation_types vt ON vt.id = pva.variation_type_id AND vt.slug = 'cor'
JOIN variation_values vv ON vv.id = pva.variation_value_id
GROUP BY vv.value;

CREATE UNIQUE INDEX IF NOT EXISTS mv_color_performance_pkey ON mv_color_performance(color_name);

-- -----------------------------------------------------------------------------
-- mv_supplier_performance
-- -----------------------------------------------------------------------------
CREATE MATERIALIZED VIEW IF NOT EXISTS mv_supplier_performance AS
SELECT
  sup.id                            AS supplier_id,
  sup.name                          AS supplier_name,
  COUNT(DISTINCT sl.id)             AS total_lots,
  COALESCE(SUM(sl.total_lot_cost), 0)  AS total_purchased_value,
  COALESCE(SUM(si.quantity), 0)        AS total_units_sold,
  COALESCE(SUM(si.total_price), 0)     AS total_revenue,
  COALESCE(SUM(si.gross_profit), 0)    AS total_gross_profit,
  ROUND(
    CASE WHEN COALESCE(SUM(si.total_price), 0) > 0
    THEN SUM(si.gross_profit) / SUM(si.total_price) * 100
    ELSE 0 END, 2
  )                                 AS avg_margin_pct,
  COUNT(DISTINCT p.id)              AS product_count
FROM suppliers sup
JOIN stock_lots sl ON sl.supplier_id = sup.id
JOIN product_variations pv ON pv.id = sl.product_variation_id
JOIN products p ON p.id = pv.product_id
LEFT JOIN sale_items si ON si.product_variation_id = pv.id
LEFT JOIN sales s ON s.id = si.sale_id AND s.status NOT IN ('cancelled', 'returned')
GROUP BY sup.id, sup.name;

CREATE UNIQUE INDEX IF NOT EXISTS mv_supplier_performance_pkey ON mv_supplier_performance(supplier_id);

-- -----------------------------------------------------------------------------
-- Primeiro refresh (sem CONCURRENTLY — seguro para views recém-criadas)
-- Ordem: mv_product_performance primeiro porque mv_abc_* dependem dela.
-- -----------------------------------------------------------------------------
REFRESH MATERIALIZED VIEW mv_product_performance;
REFRESH MATERIALIZED VIEW mv_abc_by_revenue;
REFRESH MATERIALIZED VIEW mv_abc_by_profit;
REFRESH MATERIALIZED VIEW mv_abc_by_volume;
REFRESH MATERIALIZED VIEW mv_stock_status;
REFRESH MATERIALIZED VIEW mv_customer_rfm;
REFRESH MATERIALIZED VIEW mv_daily_sales_summary;
REFRESH MATERIALIZED VIEW mv_monthly_financial;
REFRESH MATERIALIZED VIEW mv_color_performance;
REFRESH MATERIALIZED VIEW mv_supplier_performance;

-- -----------------------------------------------------------------------------
-- Garante que a função refresh_analytics_views() existe e usa CONCURRENTLY
-- (para refreshes periódicos futuros — todos os unique indexes já existem)
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION refresh_analytics_views()
RETURNS JSON
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_start   TIMESTAMPTZ := clock_timestamp();
  v_results JSON;
BEGIN
  REFRESH MATERIALIZED VIEW CONCURRENTLY mv_product_performance;
  REFRESH MATERIALIZED VIEW CONCURRENTLY mv_abc_by_revenue;
  REFRESH MATERIALIZED VIEW CONCURRENTLY mv_abc_by_profit;
  REFRESH MATERIALIZED VIEW CONCURRENTLY mv_abc_by_volume;
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

GRANT EXECUTE ON FUNCTION refresh_analytics_views() TO service_role;
