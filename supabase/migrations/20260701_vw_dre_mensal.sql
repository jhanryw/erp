-- =============================================================================
-- 20260701_vw_dre_mensal.sql
--
-- DRE Gerencial por Competência — separada do fluxo de caixa.
--
-- Conceito:
--   • CMV vem de sale_items.unit_cost * quantity (custo real no momento da venda)
--   • stock_purchase (finance_entries) NÃO entra no DRE — é saída de caixa,
--     não despesa do período. Exposto como coluna separada `saida_caixa_estoque`.
--   • Regime: competência (receita e CMV reconhecidos na data da venda).
--   • Esta view NÃO altera mv_monthly_financial nem qualquer tabela existente.
--
-- Fórmula:
--   Receita Bruta
--   − Descontos e Cashback
--   = Receita Líquida
--   − CMV (sale_items.unit_cost × quantity)
--   = Lucro Bruto
--   − Despesas Operacionais (marketing, aluguel, salários, operacional, impostos, frete, outras)
--   + Outras Receitas
--   = Lucro Líquido Gerencial
--
--   (separado) saida_caixa_estoque = SUM(finance_entries WHERE category = 'stock_purchase')
-- =============================================================================

DROP VIEW IF EXISTS vw_dre_mensal;

CREATE VIEW vw_dre_mensal AS
WITH vendas AS (
  -- Receita e CMV por mês/empresa, apenas vendas efetivadas
  SELECT
    DATE_TRUNC('month', s.sale_date)::DATE          AS mes,
    s.company_id,
    SUM(s.subtotal)                                 AS receita_bruta,
    SUM(s.discount_amount + COALESCE(s.cashback_used, 0))              AS descontos,
    SUM(s.subtotal - s.discount_amount - COALESCE(s.cashback_used, 0)) AS receita_liquida,
    SUM(COALESCE(si.unit_cost, 0) * COALESCE(si.quantity, 0))          AS cmv
  FROM sales s
  LEFT JOIN sale_items si ON si.sale_id = s.id
  WHERE s.status NOT IN ('cancelled', 'returned')
  GROUP BY DATE_TRUNC('month', s.sale_date), s.company_id
),
lancamentos AS (
  -- Despesas operacionais e saída de caixa para estoque, por mês/empresa
  SELECT
    DATE_TRUNC('month', reference_date)::DATE AS mes,
    company_id,
    SUM(CASE WHEN category = 'other_income'  AND type = 'income'  THEN amount ELSE 0 END) AS outras_receitas,
    SUM(CASE WHEN category = 'marketing'     AND type = 'expense' THEN amount ELSE 0 END) AS marketing,
    SUM(CASE WHEN category = 'rent'          AND type = 'expense' THEN amount ELSE 0 END) AS aluguel,
    SUM(CASE WHEN category = 'salaries'      AND type = 'expense' THEN amount ELSE 0 END) AS salarios,
    SUM(CASE WHEN category = 'operational'   AND type = 'expense' THEN amount ELSE 0 END) AS operacional,
    SUM(CASE WHEN category = 'taxes'         AND type = 'expense' THEN amount ELSE 0 END) AS impostos,
    SUM(CASE WHEN category = 'freight_cost'  AND type = 'expense' THEN amount ELSE 0 END) AS frete,
    SUM(CASE WHEN category = 'other_expense' AND type = 'expense' THEN amount ELSE 0 END) AS outras_despesas,
    -- Saída de caixa para estoque: NÃO é despesa do período (competência)
    SUM(CASE WHEN category = 'stock_purchase' AND type = 'expense' THEN amount ELSE 0 END) AS saida_caixa_estoque
  FROM finance_entries
  GROUP BY DATE_TRUNC('month', reference_date), company_id
),
base AS (
  -- Consolida vendas + lançamentos com FULL OUTER JOIN
  -- para não perder meses com apenas opex ou apenas vendas
  SELECT
    COALESCE(v.mes,        l.mes)        AS mes,
    COALESCE(v.company_id, l.company_id) AS company_id,
    COALESCE(v.receita_bruta,   0)       AS receita_bruta,
    COALESCE(v.descontos,       0)       AS descontos,
    COALESCE(v.receita_liquida, 0)       AS receita_liquida,
    COALESCE(v.cmv,             0)       AS cmv,
    COALESCE(l.outras_receitas, 0)       AS outras_receitas,
    COALESCE(l.marketing,       0)       AS marketing,
    COALESCE(l.aluguel,         0)       AS aluguel,
    COALESCE(l.salarios,        0)       AS salarios,
    COALESCE(l.operacional,     0)       AS operacional,
    COALESCE(l.impostos,        0)       AS impostos,
    COALESCE(l.frete,           0)       AS frete,
    COALESCE(l.outras_despesas, 0)       AS outras_despesas,
    COALESCE(l.saida_caixa_estoque, 0)   AS saida_caixa_estoque
  FROM vendas v
  FULL OUTER JOIN lancamentos l ON l.mes = v.mes AND l.company_id = v.company_id
),
calculado AS (
  -- Cálculos derivados em CTE separado para evitar reusar alias no mesmo SELECT
  SELECT
    mes,
    company_id,
    receita_bruta,
    descontos,
    receita_liquida,
    cmv,
    receita_liquida - cmv                                          AS lucro_bruto,
    outras_receitas,
    marketing, aluguel, salarios, operacional, impostos, frete, outras_despesas,
    marketing + aluguel + salarios + operacional + impostos + frete + outras_despesas AS total_opex,
    saida_caixa_estoque
  FROM base
)
SELECT
  mes,
  company_id,
  receita_bruta,
  descontos,
  receita_liquida,
  cmv,
  lucro_bruto,
  ROUND(
    CASE WHEN receita_liquida > 0 THEN lucro_bruto / receita_liquida * 100 ELSE 0 END,
    2
  ) AS margem_bruta_pct,
  marketing,
  aluguel,
  salarios,
  operacional,
  impostos,
  frete,
  outras_despesas,
  total_opex,
  outras_receitas,
  -- Lucro Líquido Gerencial: puro regime de competência, sem stock_purchase
  lucro_bruto - total_opex + outras_receitas AS lucro_liquido_gerencial,
  ROUND(
    CASE WHEN receita_liquida > 0
      THEN (lucro_bruto - total_opex + outras_receitas) / receita_liquida * 100
      ELSE 0
    END,
    2
  ) AS margem_liquida_pct,
  -- Saída de caixa para formação de inventário — exibido separado, NÃO entra no lucro
  saida_caixa_estoque
FROM calculado
ORDER BY mes DESC;

COMMENT ON VIEW vw_dre_mensal IS
  'DRE gerencial mensal por regime de competência. '
  'CMV calculado de sale_items (custo real vendido). '
  'stock_purchase exposto como saida_caixa_estoque — não impacta lucro_liquido_gerencial. '
  'Criado em 20260701.';
