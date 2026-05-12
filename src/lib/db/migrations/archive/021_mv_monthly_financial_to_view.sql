-- Migration 021: Converte mv_monthly_financial de MATERIALIZED VIEW para VIEW normal
--
-- Problema: mv_monthly_financial era refreshada diariamente via cron.
-- Vendas novas nao apareciam no financeiro ate o proximo refresh.
--
-- Solucao: VIEW normal sempre le finance_entries em tempo real.

DROP MATERIALIZED VIEW IF EXISTS mv_monthly_financial CASCADE;
DROP VIEW IF EXISTS mv_monthly_financial CASCADE;

CREATE VIEW mv_monthly_financial AS
SELECT
  DATE_TRUNC('month', reference_date)::DATE        AS month,
  SUM(CASE WHEN type = 'income'  THEN amount ELSE 0 END) AS total_income,
  SUM(CASE WHEN type = 'expense' THEN amount ELSE 0 END) AS total_expenses,
  SUM(CASE WHEN type = 'income'  THEN amount
           WHEN type = 'expense' THEN -amount
           ELSE 0 END)                              AS net_result,
  SUM(CASE WHEN category = 'stock_purchase' THEN amount ELSE 0 END) AS exp_stock,
  SUM(CASE WHEN category = 'marketing'      THEN amount ELSE 0 END) AS exp_marketing,
  SUM(CASE WHEN category = 'rent'           THEN amount ELSE 0 END) AS exp_rent,
  SUM(CASE WHEN category = 'salaries'       THEN amount ELSE 0 END) AS exp_salaries,
  SUM(CASE WHEN category = 'operational'    THEN amount ELSE 0 END) AS exp_operational,
  SUM(CASE WHEN category = 'taxes'          THEN amount ELSE 0 END) AS exp_taxes,
  SUM(CASE WHEN category = 'other_expense'  THEN amount ELSE 0 END) AS exp_other
FROM finance_entries
GROUP BY DATE_TRUNC('month', reference_date);

GRANT SELECT ON mv_monthly_financial TO authenticated, service_role;
