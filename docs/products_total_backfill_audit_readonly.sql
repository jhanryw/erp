-- =============================================================================
-- products_total_backfill_audit_readonly.sql — Fase Fiscal 5C
--
-- SOMENTE LEITURA. Nenhum UPDATE/INSERT/DELETE/migration é executado por
-- este arquivo. Seguro rodar em produção a qualquer momento.
--
-- Objetivo: antes de decidir aplicar 20260828_backfill_products_total.sql
-- (que ainda NÃO foi aplicada), saber exatamente o que ela gravaria,
-- comparado com a fórmula antiga (já superada) e com o quanto a fórmula
-- nova diverge dela — além de checar se vendas que JÁ têm products_total
-- preenchido (as ~171 anteriores à regressão de 20260614) continuam
-- batendo com a fórmula nova ou não.
--
-- Fórmula nova (definitiva, pós-Blocker 2 — a mesma que
-- 20260828_rpc_create_sale_pricing_and_products_total.sql grava para
-- vendas novas, ainda não aplicada):
--   products_total = subtotal - discount_amount + surcharge_amount
--
-- Fórmula antiga (primeira versão desta fase, já superada, só para
-- comparação — NUNCA a que será gravada):
--   products_total = subtotal - discount_amount
--
-- Cada bloco abaixo responde exatamente a um item da lista pedida, na
-- mesma ordem. Rode tudo e cole os resultados de volta — nenhum destes
-- números é assumido/estimado neste documento.
--
-- COMO RODAR:
--   psql "$DATABASE_URL" -f docs/products_total_backfill_audit_readonly.sql
-- =============================================================================


-- ═══════════════════════════════════════════════════════════════════════════
-- 1. Quantas vendas têm products_total IS NULL (visão geral)
-- ═══════════════════════════════════════════════════════════════════════════
SELECT
  COUNT(*)                                                             AS total_linhas_null,
  COUNT(*) FILTER (WHERE status = 'paid')                              AS status_paid,
  COUNT(*) FILTER (WHERE status = 'cancelled')                         AS status_cancelled,
  COUNT(*) FILTER (WHERE status = 'returned')                          AS status_returned,
  COUNT(*) FILTER (WHERE status NOT IN ('paid','cancelled','returned')) AS status_outro,
  MIN(sale_date)                                                       AS data_mais_antiga,
  MAX(sale_date)                                                       AS data_mais_recente
FROM public.sales
WHERE products_total IS NULL;


-- ═══════════════════════════════════════════════════════════════════════════
-- 2 e 3. Valor pela fórmula ANTIGA vs. valor pela fórmula NOVA, linha a linha
-- (limitado a 500 para uma primeira inspeção — ver nota no fim do arquivo
-- para rodar sem limite)
-- ═══════════════════════════════════════════════════════════════════════════
SELECT
  id AS sale_id,
  sale_date,
  status,
  subtotal,
  discount_amount,
  surcharge_amount,
  shipping_charged,
  ROUND(COALESCE(subtotal,0) - COALESCE(discount_amount,0), 2)                                AS valor_formula_antiga,
  ROUND(COALESCE(subtotal,0) - COALESCE(discount_amount,0) + COALESCE(surcharge_amount,0), 2)  AS valor_formula_nova,
  ROUND(COALESCE(surcharge_amount,0), 2)                                                       AS divergencia
FROM public.sales
WHERE products_total IS NULL
ORDER BY divergencia DESC, id
LIMIT 500;
-- Nota: divergência (novo − antigo) = surcharge_amount sempre, por
-- construção matemática das duas fórmulas — confirmado aqui contra dado
-- real, não presumido. Se a contagem do bloco 1 for maior que 500, rode
-- este bloco de novo sem o LIMIT para ver todas as linhas.


-- ═══════════════════════════════════════════════════════════════════════════
-- 4, 5, 6. Quantas linhas divergiriam / soma total da divergência / maior divergência
-- ═══════════════════════════════════════════════════════════════════════════
SELECT
  COUNT(*)                                                               AS total_vendas_null,
  COUNT(*) FILTER (WHERE COALESCE(surcharge_amount,0) > 0)               AS quantidade_linhas_que_divergiriam,
  COUNT(*) FILTER (WHERE COALESCE(surcharge_amount,0) = 0)               AS quantidade_linhas_sem_divergencia,
  ROUND(SUM(COALESCE(surcharge_amount,0)), 2)                            AS soma_total_da_divergencia,
  MAX(COALESCE(surcharge_amount,0))                                      AS maior_divergencia,
  MIN(COALESCE(surcharge_amount,0)) FILTER (WHERE surcharge_amount > 0)  AS menor_divergencia_nao_zero,
  ROUND(AVG(COALESCE(surcharge_amount,0)) FILTER (WHERE surcharge_amount > 0), 2) AS divergencia_media_quando_existe
FROM public.sales
WHERE products_total IS NULL;


-- ═══════════════════════════════════════════════════════════════════════════
-- 7, 8, 9. Vendas com surcharge_amount > 0 / shipping_charged > 0 / discount_amount > 0
-- (entre as vendas com products_total IS NULL — universo do backfill)
-- ═══════════════════════════════════════════════════════════════════════════
SELECT
  COUNT(*) FILTER (WHERE COALESCE(surcharge_amount,0) > 0) AS vendas_com_surcharge_amount_maior_que_zero,
  COUNT(*) FILTER (WHERE COALESCE(shipping_charged,0) > 0) AS vendas_com_shipping_charged_maior_que_zero,
  COUNT(*) FILTER (WHERE COALESCE(discount_amount,0)  > 0) AS vendas_com_discount_amount_maior_que_zero
FROM public.sales
WHERE products_total IS NULL;


-- ═══════════════════════════════════════════════════════════════════════════
-- 10. Vendas em que products_total JÁ preenchido não bate com a fórmula nova
-- (universo INVERSO dos blocos acima — as ~171 vendas anteriores à
-- regressão de 20260614, que já têm products_total gravado pela fórmula
-- original de 20260613_shipping_fiscal_ready.sql: subtotal - discount_amount,
-- SEM surcharge_amount. Se alguma delas tiver surcharge_amount > 0, o
-- valor já gravado ficaria desatualizado em relação à fórmula nova — este
-- backfill (20260828_backfill_products_total.sql) NÃO toca essas linhas,
-- só as que estão NULL, então isso é só informativo, não um problema que
-- o backfill atual resolve ou piora)
-- ═══════════════════════════════════════════════════════════════════════════
SELECT
  id AS sale_id,
  sale_date,
  status,
  subtotal,
  discount_amount,
  surcharge_amount,
  products_total AS products_total_ja_gravado,
  ROUND(COALESCE(subtotal,0) - COALESCE(discount_amount,0) + COALESCE(surcharge_amount,0), 2) AS valor_formula_nova,
  ROUND(products_total - (COALESCE(subtotal,0) - COALESCE(discount_amount,0) + COALESCE(surcharge_amount,0)), 2) AS diferenca
FROM public.sales
WHERE products_total IS NOT NULL
  AND ROUND(products_total, 2) <> ROUND(COALESCE(subtotal,0) - COALESCE(discount_amount,0) + COALESCE(surcharge_amount,0), 2)
ORDER BY diferenca DESC, id;
-- Esperado, dado que sale_items.surcharge_amount/sales.surcharge_amount
-- são recentes: ZERO linhas, ou só linhas onde surcharge_amount > 0 for
-- possível historicamente (sales.surcharge_amount existe desde
-- 026_sale_surcharge_shipment_origin_nullable.sql — mais antigo que a
-- regressão de products_total — então É POSSÍVEL que alguma das 171
-- vendas históricas já preenchidas tenha usado surcharge_amount &gt; 0 e
-- portanto divirja aqui). Se aparecer alguma linha, é só informativo
-- nesta rodada — decidir separadamente se vale re-backfillar essas
-- também, não é o que 20260828_backfill_products_total.sql faz hoje.


-- ═══════════════════════════════════════════════════════════════════════════
-- Extra — verificação cruzada de integridade (não pedido explicitamente,
-- mas barato e relevante antes de confiar em qualquer número acima):
-- subtotal bate com a soma de sale_items.total_price?
-- ═══════════════════════════════════════════════════════════════════════════
SELECT
  s.id AS sale_id,
  s.subtotal AS sales_subtotal,
  ROUND(SUM(si.total_price), 2) AS soma_sale_items_total_price,
  ROUND(s.subtotal - SUM(si.total_price), 2) AS diferenca
FROM public.sales s
JOIN public.sale_items si ON si.sale_id = s.id
WHERE s.products_total IS NULL
GROUP BY s.id, s.subtotal
HAVING ROUND(s.subtotal - SUM(si.total_price), 2) <> 0
LIMIT 20;
-- Esperado: ZERO linhas. Qualquer linha aqui é dado inconsistente a
-- investigar antes do backfill — não presumir a causa sem olhar.
