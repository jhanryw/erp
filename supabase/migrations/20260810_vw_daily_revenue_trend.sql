-- =============================================================================
-- 20260810_vw_daily_revenue_trend.sql
--
-- Gráfico de tendência de faturamento (estilo mercado financeiro) — v1.
--
-- Transforma public.sales numa série CONTÍNUA de calendário por dia (dias
-- sem venda aparecem com revenue=0, nunca somem), com médias móveis de 7 e
-- 30 dias calculadas por DIA CALENDÁRIO (nunca pelas últimas N linhas com
-- venda), mais sinais de sazonalidade (dia da semana, posição no mês,
-- semana/mês até a data) para permitir observar tendência sem confundir
-- com volatilidade diária.
--
-- FONTE DE VERDADE — decisão já tomada, não reavaliada aqui:
--   public.sales.sale_date  -> data comercial oficial (nunca corrigida por
--                              created_at; sale_date editado posteriormente
--                              é um problema de auditoria separado — ver
--                              audit_logs, fora do escopo desta migration)
--   public.sales.total      -> faturamento reconhecido da venda
--   public.sales.status     -> IN ('paid','shipped','delivered') — mesma
--                              definição de "venda válida" fixada na
--                              auditoria original do módulo de vendas
--                              (exclui pending, cancelled e returned).
--   public.sales.company_id -> isolamento multi-tenant preservado via
--                              PARTITION BY em toda window function (não
--                              é apenas um filtro externo — cada empresa
--                              tem sua própria série/médias, mesmo que
--                              hoje só exista a Santtorini).
--
-- Explicitamente NÃO usado: products_total (NULL desde 14/06 — ver
-- docs/products-total-regression-analysis.md), sale_items (faturamento não
-- é derivado de item), sales.payment_method, sales.seller_id (usar
-- responsible_seller_id quando necessário — fora do escopo deste gráfico).
--
-- ARQUITETURA: VIEW normal (não materializada, não função). Sempre
-- recomputada — resolve o problema de staleness que mv_daily_sales_summary
-- já tem hoje (refresh manual). Volume atual pequeno o suficiente para
-- recalcular as window functions a cada consulta sem custo relevante.
--
-- MÉDIAS MÓVEIS (dias calendário, não "últimas N linhas com venda"):
--   mm7  = AVG(revenue) das 7 datas de calendário terminando no dia atual
--   mm30 = AVG(revenue) das 30 datas de calendário terminando no dia atual
--   Nos primeiros 6/29 dias de histórico, a média usa a quantidade de
--   dias disponível até então (não retorna NULL) — decisão explícita do
--   escopo, documentada aqui e no serviço TypeScript.
--
-- CRESCIMENTO (mm7_growth_pct, mm30_growth_pct, vs_weekday_avg_pct,
-- wtd_growth_pct, mtd_growth_pct): fórmula (atual/anterior - 1) * 100,
-- retornando NULL (nunca 0, NaN ou Infinity) quando o valor de referência
-- é NULL (ainda não há histórico suficiente) ou é exatamente zero
-- (divisão por zero matematicamente indefinida).
--
-- SEMANA: weekday_number segue ISODOW (1=segunda ... 7=domingo), pareado
-- com week_start = segunda-feira da semana ISO (DATE_TRUNC('week', ...)).
-- wtd_revenue = acumulado da semana (segunda até a data). Comparação
-- semanal usa período EQUIVALENTE (ex.: quarta atual = segunda→quarta
-- comparado com segunda→quarta da semana anterior), via LAG de 7 linhas
-- sobre uma série sem buracos — nunca compara semana parcial com semana
-- cheia. Deliberadamente NÃO inclui "faturamento da semana anterior
-- completa" como campo separado, para não abrir espaço para alguém no
-- frontend comparar (por engano) uma semana parcial com uma semana cheia.
--
-- MÊS: mtd_revenue = acumulado do mês (dia 1 até a data).
-- previous_month_same_period_revenue = mesmo intervalo de dias no mês
-- anterior, com cap no último dia real do mês anterior quando ele tem
-- menos dias (ex.: dia 31 de um mês vs. fevereiro com 28/29 dias).
--
-- IDEMPOTENTE: DROP VIEW IF EXISTS + CREATE VIEW.
-- ROLLBACK: ver bloco comentado ao final.
-- =============================================================================

DROP VIEW IF EXISTS public.vw_daily_revenue_trend;

CREATE VIEW public.vw_daily_revenue_trend AS
WITH company_range AS (
  -- Primeiro dia de faturamento válido de cada empresa até hoje em
  -- America/Fortaleza (mesmo fuso já usado por rpc_create_sale ao gravar
  -- sale_date — ver src/lib/utils/date.ts:brazilDate()).
  SELECT
    s.company_id,
    MIN(s.sale_date) AS first_date,
    (CURRENT_TIMESTAMP AT TIME ZONE 'America/Fortaleza')::date AS last_date
  FROM public.sales s
  WHERE s.status IN ('paid', 'shipped', 'delivered')
  GROUP BY s.company_id
),
calendar AS (
  -- Série contínua de calendário — garante que dias sem venda existam
  -- como linha (revenue=0), nunca fiquem ausentes.
  SELECT
    cr.company_id,
    gs.d::date AS date
  FROM company_range cr
  CROSS JOIN generate_series(
    cr.first_date::timestamp, cr.last_date::timestamp, interval '1 day'
  ) AS gs(d)
),
daily_raw AS (
  SELECT
    s.company_id,
    s.sale_date AS date,
    SUM(s.total) AS revenue,
    COUNT(*)     AS orders
  FROM public.sales s
  WHERE s.status IN ('paid', 'shipped', 'delivered')
  GROUP BY s.company_id, s.sale_date
),
daily_base AS (
  SELECT
    c.company_id,
    c.date,
    COALESCE(r.revenue, 0)::numeric(12,2) AS revenue,
    COALESCE(r.orders, 0)::int            AS orders,
    CASE WHEN COALESCE(r.orders, 0) > 0
      THEN ROUND(COALESCE(r.revenue, 0) / r.orders, 2)
      ELSE 0
    END AS avg_ticket,
    EXTRACT(ISODOW FROM c.date)::int AS weekday_number,
    CASE EXTRACT(ISODOW FROM c.date)::int
      WHEN 1 THEN 'Segunda-feira'
      WHEN 2 THEN 'Terça-feira'
      WHEN 3 THEN 'Quarta-feira'
      WHEN 4 THEN 'Quinta-feira'
      WHEN 5 THEN 'Sexta-feira'
      WHEN 6 THEN 'Sábado'
      WHEN 7 THEN 'Domingo'
    END AS weekday_name,
    EXTRACT(DAY   FROM c.date)::int AS day_of_month,
    EXTRACT(MONTH FROM c.date)::int AS month,
    EXTRACT(YEAR  FROM c.date)::int AS year,
    EXTRACT(WEEK  FROM c.date)::int AS iso_week,
    DATE_TRUNC('week', c.date)::date AS week_start,
    CASE
      WHEN EXTRACT(DAY FROM c.date)::int <= 10 THEN 'inicio'
      WHEN EXTRACT(DAY FROM c.date)::int <= 20 THEN 'meio'
      ELSE 'fim'
    END AS month_period
  FROM calendar c
  LEFT JOIN daily_raw r
    ON r.company_id = c.company_id AND r.date = c.date
),
daily_metrics AS (
  -- Primeira camada de window functions (não podem ser aninhadas dentro
  -- da mesma expressão de outra window function — por isso o LAG usado
  -- para as métricas "N dias atrás" fica numa camada seguinte).
  SELECT
    d.*,
    ROUND(AVG(d.revenue) OVER (
      PARTITION BY d.company_id ORDER BY d.date
      ROWS BETWEEN 6 PRECEDING AND CURRENT ROW
    ), 2) AS mm7,
    ROUND(AVG(d.revenue) OVER (
      PARTITION BY d.company_id ORDER BY d.date
      ROWS BETWEEN 29 PRECEDING AND CURRENT ROW
    ), 2) AS mm30,
    -- Últimas 4 ocorrências ANTERIORES do mesmo dia da semana — partição
    -- por (company_id, weekday_number) faz cada linha do frame ser
    -- exatamente uma semana anterior (calendário sem buracos garante
    -- isso). "1 PRECEDING" como limite superior exclui a linha atual.
    ROUND(AVG(d.revenue) OVER (
      PARTITION BY d.company_id, d.weekday_number ORDER BY d.date
      ROWS BETWEEN 4 PRECEDING AND 1 PRECEDING
    ), 2) AS weekday_recent_avg,
    ROUND(SUM(d.revenue) OVER (
      PARTITION BY d.company_id, d.week_start ORDER BY d.date
      ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW
    ), 2) AS wtd_revenue,
    ROUND(SUM(d.revenue) OVER (
      PARTITION BY d.company_id, d.year, d.month ORDER BY d.date
      ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW
    ), 2) AS mtd_revenue
  FROM daily_base d
),
daily_metrics_lagged AS (
  -- Segunda camada: valores "N dias/semanas atrás" via LAG sobre colunas
  -- já materializadas na camada anterior (nunca sobre outra window
  -- function diretamente — isso o Postgres não permite).
  SELECT
    dm.*,
    LAG(dm.mm7, 7)   OVER (PARTITION BY dm.company_id ORDER BY dm.date) AS mm7_7d_ago,
    LAG(dm.mm30, 30) OVER (PARTITION BY dm.company_id ORDER BY dm.date) AS mm30_30d_ago,
    -- LAG de 7 linhas sobre wtd_revenue = mesmo dia da semana passada,
    -- já acumulado de segunda até aquele dia = período equivalente.
    LAG(dm.wtd_revenue, 7) OVER (PARTITION BY dm.company_id ORDER BY dm.date) AS wtd_revenue_prev_week_equivalent
  FROM daily_metrics dm
),
mtd_prev AS (
  -- Mesmo intervalo de dias (1 até day_of_month) no mês anterior, com cap
  -- no último dia real do mês anterior quando ele tiver menos dias.
  SELECT
    d.company_id,
    d.date,
    COALESCE(SUM(p.revenue), 0)::numeric(12,2) AS previous_month_same_period_revenue
  FROM daily_base d
  LEFT JOIN daily_base p
    ON p.company_id = d.company_id
   AND p.date >= DATE_TRUNC('month', d.date - INTERVAL '1 month')::date
   AND p.date <= LEAST(
         (DATE_TRUNC('month', d.date) - INTERVAL '1 day')::date,
         (DATE_TRUNC('month', d.date - INTERVAL '1 month')::date + (d.day_of_month - 1))
       )
  GROUP BY d.company_id, d.date
)
SELECT
  dml.date,
  dml.company_id,
  dml.revenue,
  dml.orders,
  dml.avg_ticket,

  dml.mm7,
  dml.mm30,
  dml.mm7_7d_ago,
  dml.mm30_30d_ago,
  CASE
    WHEN dml.mm7_7d_ago IS NULL OR dml.mm7_7d_ago = 0 THEN NULL
    ELSE ROUND((dml.mm7 / dml.mm7_7d_ago - 1) * 100, 2)
  END AS mm7_growth_pct,
  CASE
    WHEN dml.mm30_30d_ago IS NULL OR dml.mm30_30d_ago = 0 THEN NULL
    ELSE ROUND((dml.mm30 / dml.mm30_30d_ago - 1) * 100, 2)
  END AS mm30_growth_pct,

  dml.weekday_number,
  dml.weekday_name,
  dml.weekday_recent_avg,
  CASE
    WHEN dml.weekday_recent_avg IS NULL OR dml.weekday_recent_avg = 0 THEN NULL
    ELSE ROUND((dml.revenue / dml.weekday_recent_avg - 1) * 100, 2)
  END AS vs_weekday_avg_pct,

  dml.day_of_month,
  dml.month,
  dml.year,
  dml.month_period,

  dml.iso_week,
  dml.week_start,
  dml.wtd_revenue,
  dml.wtd_revenue_prev_week_equivalent,
  CASE
    WHEN dml.wtd_revenue_prev_week_equivalent IS NULL OR dml.wtd_revenue_prev_week_equivalent = 0 THEN NULL
    ELSE ROUND((dml.wtd_revenue / dml.wtd_revenue_prev_week_equivalent - 1) * 100, 2)
  END AS wtd_growth_pct,

  dml.mtd_revenue,
  mp.previous_month_same_period_revenue,
  CASE
    WHEN mp.previous_month_same_period_revenue IS NULL OR mp.previous_month_same_period_revenue = 0 THEN NULL
    ELSE ROUND((dml.mtd_revenue / mp.previous_month_same_period_revenue - 1) * 100, 2)
  END AS mtd_growth_pct

FROM daily_metrics_lagged dml
LEFT JOIN mtd_prev mp ON mp.company_id = dml.company_id AND mp.date = dml.date
ORDER BY dml.company_id, dml.date;

COMMENT ON VIEW public.vw_daily_revenue_trend IS
  'Série contínua de calendário de faturamento diário por company_id, com '
  'MM7/MM30 por dia calendário, comparação com a média das últimas 4 '
  'ocorrências do mesmo dia da semana, semana-até-a-data (período '
  'equivalente à semana anterior) e mês-até-a-data (mesmo período do mês '
  'anterior, com cap em meses mais curtos). Fonte: public.sales.sale_date/'
  'total/status (IN paid/shipped/delivered — definição de "venda válida" '
  'fixada na auditoria original do módulo de vendas; exclui pending, '
  'cancelled e returned). Dias sem venda aparecem com '
  'revenue=0/orders=0/avg_ticket=0. Todos os campos de crescimento retornam '
  'NULL (nunca 0/NaN/Infinity) quando o valor de referência não existe '
  'ainda ou é zero. Não sincroniza nem depende de finance_entries, '
  'audit_logs ou sale_date editado posteriormente — ver auditoria técnica '
  'do módulo de vendas para essas questões, tratadas separadamente. '
  'Criada em 20260810.';

GRANT SELECT ON public.vw_daily_revenue_trend TO authenticated, service_role;

NOTIFY pgrst, 'reload schema';

-- =============================================================================
-- ROLLBACK
-- =============================================================================
/*
DROP VIEW IF EXISTS public.vw_daily_revenue_trend;
*/
