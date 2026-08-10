-- =============================================================================
-- revenue-trend-validation-readonly.sql
--
-- Consultas de validação para public.vw_daily_revenue_trend (criada em
-- supabase/migrations/20260810_vw_daily_revenue_trend.sql).
--
-- 100% read-only. Nada aqui altera dados. Estas consultas NÃO foram
-- executadas contra o banco real nesta sessão — este ambiente não tem
-- acesso autenticado ao Supabase (MCP do Supabase exige autorização que
-- não está disponível aqui). Rode manualmente no SQL Editor do Supabase
-- e confira os resultados esperados descritos em cada bloco.
--
-- Ajuste company_id conforme o ambiente. A query abaixo descobre o(s)
-- id(s) reais antes de qualquer outra consulta.
-- =============================================================================

-- 0. Descobrir company_id real (a Santtorini é a única empresa cadastrada
--    até hoje — ver src/lib/db/migrations/archive/005_multi_tenant.sql).
SELECT id, name, slug FROM public.companies ORDER BY id;


-- =============================================================================
-- 1. Dia sem venda aparece como zero (nunca ausente)
-- =============================================================================
SELECT date, revenue, orders, avg_ticket
FROM public.vw_daily_revenue_trend
WHERE company_id = 1
ORDER BY date
LIMIT 60;
-- Esperado: nenhuma data "faltando" na sequência (todo dia de calendário
-- presente); dias sem venda real devem ter revenue=0, orders=0,
-- avg_ticket=0 (nunca NULL).


-- =============================================================================
-- 2. MM7 usa exatamente dias calendário (não últimas 7 linhas com venda)
-- =============================================================================
-- Substitua a data abaixo por uma data real presente no seu histórico.
WITH manual AS (
  SELECT AVG(revenue) AS mm7_manual
  FROM public.vw_daily_revenue_trend
  WHERE company_id = 1
    AND date BETWEEN DATE '2026-07-25' - INTERVAL '6 days' AND DATE '2026-07-25'
)
SELECT v.date, v.mm7, m.mm7_manual, (v.mm7 - m.mm7_manual) AS diff
FROM public.vw_daily_revenue_trend v, manual m
WHERE v.company_id = 1 AND v.date = '2026-07-25';
-- Esperado: diff = 0 (ou arredondamento de centavo). O cálculo manual usa
-- as 7 datas de CALENDÁRIO, incluindo as que tiveram revenue=0 — se o
-- diff bater, a MM7 não está pulando dias sem venda.


-- =============================================================================
-- 3. MM30 usa dias calendário (mesmo teste, janela de 30 dias)
-- =============================================================================
WITH manual AS (
  SELECT AVG(revenue) AS mm30_manual
  FROM public.vw_daily_revenue_trend
  WHERE company_id = 1
    AND date BETWEEN DATE '2026-07-25' - INTERVAL '29 days' AND DATE '2026-07-25'
)
SELECT v.date, v.mm30, m.mm30_manual, (v.mm30 - m.mm30_manual) AS diff
FROM public.vw_daily_revenue_trend v, manual m
WHERE v.company_id = 1 AND v.date = '2026-07-25';
-- Esperado: diff = 0.


-- =============================================================================
-- 4. Vendas canceladas/devolvidas não entram no faturamento
-- =============================================================================
-- Passo A: localizar uma sale_date onde a ÚNICA venda do dia foi cancelada/devolvida.
SELECT s.sale_date, s.status, s.total, COUNT(*) OVER (PARTITION BY s.sale_date) AS vendas_no_dia
FROM public.sales s
WHERE s.company_id = 1
ORDER BY s.sale_date DESC
LIMIT 30;

-- Passo B: para uma sale_date onde vendas_no_dia = 1 e status IN ('cancelled','returned'),
-- confirme que a view mostra revenue = 0 nesse dia:
-- SELECT * FROM public.vw_daily_revenue_trend WHERE company_id = 1 AND date = '<sale_date>';


-- =============================================================================
-- 5. company_id isolado (nenhuma linha "solta" fora de public.companies)
-- =============================================================================
SELECT DISTINCT v.company_id
FROM public.vw_daily_revenue_trend v
LEFT JOIN public.companies c ON c.id = v.company_id
WHERE c.id IS NULL;
-- Esperado: 0 linhas.


-- =============================================================================
-- 6. Crescimento não gera divisão por zero / NaN / Infinity
-- =============================================================================
SELECT date, mm7_growth_pct, mm30_growth_pct, vs_weekday_avg_pct, wtd_growth_pct, mtd_growth_pct
FROM public.vw_daily_revenue_trend
WHERE company_id = 1
ORDER BY date
LIMIT 40;
-- Esperado: a consulta executa sem erro (SQL não tem como retornar NaN/
-- Infinity para tipo numeric — um erro de divisão por zero apareceria como
-- ERROR na consulta, não como valor). Confirme visualmente que os
-- primeiros dias do histórico (antes de existir "N dias atrás" ou de a
-- referência ser zero) retornam NULL nessas colunas — não 0, não erro.


-- =============================================================================
-- 7. Comparação de dia da semana não inclui o próprio dia
-- =============================================================================
SELECT date, weekday_name, revenue, weekday_recent_avg, vs_weekday_avg_pct
FROM public.vw_daily_revenue_trend
WHERE company_id = 1 AND weekday_number = 2 -- terça-feira
ORDER BY date;
-- Esperado: para a primeira terça do histórico, weekday_recent_avg = NULL
-- (nenhuma terça anterior). Para a segunda terça, weekday_recent_avg deve
-- ser igual ao revenue da primeira terça (não pode ser a média das duas,
-- o que aconteceria se a linha atual contaminasse a própria referência).


-- =============================================================================
-- 8. Ranges do frontend não alteram o cálculo das médias
-- =============================================================================
-- A garantia é estrutural: a view sempre calcula sobre a série completa
-- (ver migration 20260810), e o frontend só recorta o array já pronto
-- (src/components/modules/dashboards/daily-sales-chart.tsx). Esta consulta
-- documenta o valor de referência de uma data específica para comparar
-- manualmente com o que aparece no tooltip do gráfico ao trocar de range:
SELECT date, mm7, mm30
FROM public.vw_daily_revenue_trend
WHERE company_id = 1 AND date = '2026-07-01';
-- Esperado: o valor de mm30 exibido no gráfico para 2026-07-01 deve ser
-- idêntico ao retornado aqui, seja o range selecionado "30D" ou "Tudo".


-- =============================================================================
-- 9. Timezone coerente com America/Fortaleza
-- =============================================================================
SELECT
  MAX(date) AS ultimo_dia_na_serie,
  (CURRENT_TIMESTAMP AT TIME ZONE 'America/Fortaleza')::date AS hoje_fortaleza,
  CURRENT_DATE AS hoje_utc_servidor
FROM public.vw_daily_revenue_trend
WHERE company_id = 1;
-- Esperado: ultimo_dia_na_serie = hoje_fortaleza. hoje_utc_servidor pode
-- diferir em até 1 dia dependendo do horário de execução — isso é
-- esperado e não é bug (é exatamente o motivo de a view usar
-- 'America/Fortaleza' explicitamente em vez de CURRENT_DATE).


-- =============================================================================
-- 10. Valores agregados batem com SUM(sales.total) direto
-- =============================================================================
SELECT
  (SELECT COALESCE(SUM(revenue), 0) FROM public.vw_daily_revenue_trend
   WHERE company_id = 1 AND date BETWEEN '2026-07-01' AND '2026-07-31') AS soma_view,
  (SELECT COALESCE(SUM(total), 0) FROM public.sales
   WHERE company_id = 1 AND status NOT IN ('cancelled', 'returned')
     AND sale_date BETWEEN '2026-07-01' AND '2026-07-31') AS soma_sales_direto;
-- Esperado: os dois valores idênticos. Repita para outros meses/períodos
-- de controle antes de confiar no gráfico para decisões.
