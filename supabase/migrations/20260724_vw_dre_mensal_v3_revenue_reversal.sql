-- =============================================================================
-- 20260724_vw_dre_mensal_v3_revenue_reversal.sql
--
-- Financeiro 2.1 — Estabilidade de competência do DRE (view)
--
-- Reescreve vw_dre_mensal para reconhecer receita_bruta/descontos/receita_liquida/
-- cmv por sales.sale_date, sem filtro retroativo por sales.status, e reverter
-- esses valores no mês de cancelled_at/returned_at (nunca em finance_entries).
--
-- Também exclui do Opex (outras_despesas) as 15 finance_entries automáticas de
-- cancelamento/devolução (category='other_expense', sale_id preenchido,
-- descrição 'Cancelamento —%'/'Devolução —%') que não têm nenhuma evidência de
-- reembolso financeiro real (paid_at/payment_method/cash_movement_id nulos em
-- todas). Essas linhas permanecem intactas em finance_entries — só saem da
-- soma de Opex desta view. Nenhum dado é alterado, apagado ou reclassificado.
--
-- lancamentos (exceto outras_despesas), base, calculado permanecem com a mesma
-- estrutura da v2 — só a fonte de receita/CMV e a exclusão de Opex mudaram.
-- =============================================================================

DROP VIEW IF EXISTS public.vw_dre_mensal;

CREATE VIEW public.vw_dre_mensal AS
WITH cmv_por_venda AS (
  -- Agrega CMV por venda — evita fan-out no JOIN com sales (inalterado)
  SELECT
    sale_id,
    SUM(COALESCE(unit_cost, 0) * COALESCE(quantity, 0)) AS cmv
  FROM public.sale_items
  GROUP BY sale_id
),
vendas_original AS (
  -- Reconhecimento original: TODA venda, por mês de sale_date, sem filtro
  -- de status. Um mês, uma vez reportado, não é reescrito por um
  -- cancelamento/devolução posterior de uma venda daquele mês.
  SELECT
    DATE_TRUNC('month', s.sale_date)::DATE AS mes,
    s.company_id,
    SUM(s.subtotal)                                                    AS receita_bruta,
    SUM(s.discount_amount + COALESCE(s.cashback_used, 0))              AS descontos,
    SUM(s.subtotal - s.discount_amount - COALESCE(s.cashback_used, 0)) AS receita_liquida,
    SUM(COALESCE(c.cmv, 0))                                            AS cmv
  FROM public.sales s
  LEFT JOIN cmv_por_venda c ON c.sale_id = s.id
  GROUP BY DATE_TRUNC('month', s.sale_date), s.company_id
),
vendas_reversao AS (
  -- Reversão: data determinada pelo status da venda, nunca por COALESCE
  -- entre os dois campos — evita usar a data errada se uma linha
  -- inconsistente tiver os dois timestamps preenchidos.
  SELECT
    DATE_TRUNC(
      'month',
      CASE
        WHEN s.status = 'cancelled' THEN s.cancelled_at
        WHEN s.status = 'returned'  THEN s.returned_at
      END
    )::DATE AS mes,
    s.company_id,
    SUM(s.subtotal)                                                    AS receita_bruta,
    SUM(s.discount_amount + COALESCE(s.cashback_used, 0))              AS descontos,
    SUM(s.subtotal - s.discount_amount - COALESCE(s.cashback_used, 0)) AS receita_liquida,
    SUM(COALESCE(c.cmv, 0))                                            AS cmv
  FROM public.sales s
  LEFT JOIN cmv_por_venda c ON c.sale_id = s.id
  WHERE (s.status = 'cancelled' AND s.cancelled_at IS NOT NULL)
     OR (s.status = 'returned'  AND s.returned_at  IS NOT NULL)
  GROUP BY 1, s.company_id
),
vendas AS (
  -- Líquido: original menos reversão, por mês/empresa. FULL OUTER JOIN
  -- garante que um mês só com reversão (sem venda nova) não desaparece.
  SELECT
    COALESCE(o.mes, r.mes)                 AS mes,
    COALESCE(o.company_id, r.company_id)   AS company_id,
    COALESCE(o.receita_bruta, 0)   - COALESCE(r.receita_bruta, 0)   AS receita_bruta,
    COALESCE(o.descontos, 0)       - COALESCE(r.descontos, 0)       AS descontos,
    COALESCE(o.receita_liquida, 0) - COALESCE(r.receita_liquida, 0) AS receita_liquida,
    COALESCE(o.cmv, 0)             - COALESCE(r.cmv, 0)             AS cmv
  FROM vendas_original o
  FULL OUTER JOIN vendas_reversao r ON r.mes = o.mes AND r.company_id = o.company_id
),
lancamentos AS (
  -- Despesas operacionais e saída de caixa para estoque, por mês/empresa.
  -- outras_despesas exclui as 15 finance_entries automáticas de
  -- cancelamento/devolução sem evidência de reembolso (ver cabeçalho) —
  -- todas as outras categorias permanecem exatamente como na v2.
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
    SUM(
      CASE
        WHEN category = 'other_expense' AND type = 'expense'
         AND NOT (
           sale_id IS NOT NULL
           AND (description LIKE 'Cancelamento —%' OR description LIKE 'Devolução —%')
         )
        THEN amount ELSE 0
      END
    ) AS outras_despesas,
    SUM(CASE WHEN category = 'stock_purchase' AND type = 'expense' THEN amount ELSE 0 END) AS saida_caixa_estoque
  FROM public.finance_entries
  GROUP BY DATE_TRUNC('month', reference_date), company_id
),
base AS (
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
  SELECT
    mes, company_id, receita_bruta, descontos, receita_liquida, cmv,
    receita_liquida - cmv AS lucro_bruto,
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
  ROUND(CASE WHEN receita_liquida > 0 THEN lucro_bruto / receita_liquida * 100 ELSE 0 END, 2) AS margem_bruta_pct,
  marketing, aluguel, salarios, operacional, impostos, frete, outras_despesas,
  total_opex,
  lucro_bruto - total_opex AS resultado_operacional,
  outras_receitas,
  lucro_bruto - total_opex + outras_receitas AS lucro_liquido_gerencial,
  ROUND(
    CASE WHEN receita_liquida > 0
      THEN (lucro_bruto - total_opex + outras_receitas) / receita_liquida * 100
      ELSE 0
    END, 2
  ) AS margem_liquida_pct,
  saida_caixa_estoque
FROM calculado
ORDER BY mes DESC;

COMMENT ON VIEW public.vw_dre_mensal IS
  'DRE gerencial mensal por regime de competência (v3 — revenue reversal). '
  'receita_bruta/descontos/receita_liquida/cmv reconhecidos por sale_date e '
  'revertidos por cancelled_at/returned_at (nunca por finance_entries). '
  'Esta view impede a reescrita retroativa de um mês causada por mudança de '
  'status ou cancelamento/devolução tardios de uma venda antiga — mas sales/'
  'sale_items continuam sendo a fonte dos fatos comerciais, e uma edição '
  'direta nesses dados ainda pode alterar o resultado de um mês já reportado. '
  'outras_despesas exclui as finance_entries automáticas de cancelamento/'
  'devolução sem evidência de reembolso real (other_expense, sale_id '
  'preenchido, descrição padrão) — os registros permanecem intactos na '
  'tabela, só não entram mais no Opex desta view. Atualizado em 20260724.';

GRANT SELECT ON public.vw_dre_mensal TO authenticated, service_role;

NOTIFY pgrst, 'reload schema';

-- =============================================================================
-- ROLLBACK
-- =============================================================================
/*
DROP VIEW IF EXISTS public.vw_dre_mensal;
-- Reaplicar o CREATE VIEW de 20260701_vw_dre_mensal.sql na íntegra, incluindo
-- seu COMMENT ON VIEW original. Depois: GRANT SELECT ON public.vw_dre_mensal
-- TO authenticated, service_role; NOTIFY pgrst, 'reload schema';
*/
