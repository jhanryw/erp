-- FASE MVP CHATWOOT — Enriquecimento comercial: categorias compradas +
-- tamanho preferencial por Tipo de produto.
--
-- ACHADOS DA AUDITORIA (não presumidos — confirmados contra migrations
-- reais antes de escrever esta função):
--
--   1. "Categoria" na linguagem do pedido (Pijama/Calcinha/Sutiã) NÃO é a
--      tabela `categories` (que hoje representa sub-classificação de
--      ESTILO dentro de um Tipo, ex.: "Básico"/"Push Up"/"Rendada" dentro
--      de Sutiã — confirmado em 20260729_pim_product_types_models.sql,
--      comentário: "categories hoje mistura Tipo e Categoria... a maioria
--      é Tipo disfarçado"). É `product_types` (Tipo) — tabela dedicada,
--      criada na mesma migration, com `products.tipo` (slug normalizado)
--      como chave de ligação (confirmado em
--      202607301700_pim_seed_legacy_product_types.sql: todo Tipo legado
--      tem uma linha 1:1 em product_types com o MESMO slug usado em
--      products.tipo).
--
--   2. `product_variations.size`/`.color` são colunas MORTAS — confirmado
--      contra amostra real de produção (202608101400_fix_vw_purchase_
--      suggestions_color_size.sql: "retornam NULL em 100% da amostra real
--      de 20 linhas testada"). O tamanho real vive em
--      `product_variation_attributes` (product_variation_id →
--      variation_value_id) + `variation_values` (value) +
--      `variation_types` (slug='tamanho') — mesmo padrão já usado e
--      validado em vw_stock_live_balances/vw_purchase_suggestions
--      (MAX(...) FILTER (WHERE vt.slug = 'tamanho'), sem fan-out).
--
--   3. Existe hoje só 1 variation_type de tamanho (slug 'tamanho') — não
--      uma escala numérica por Tipo (confirmado em
--      20260707_category_attributes.sql: "cor e tamanho hoje, únicos
--      tipos existentes em produção"). O agrupamento pedido
--      (qarvon_size_sutia, qarvon_size_calcinha...) vem do Tipo do
--      produto, não de uma escala de tamanho diferente por Tipo — o valor
--      em si (P/M/G/GG/48/50/52/...) é sempre da mesma lista compartilhada
--      de variation_values.
--
--   4. Validade de venda reaproveita EXATAMENTE o mesmo filtro já usado em
--      computeCustomerCommercialAttributes (reconciliation.ts, Fase 4):
--      sales.status NOT IN ('cancelled', 'returned'). Nenhuma lógica nova
--      de troca/devolução — mesma regra já confiável em produção.
--
-- REGRA DE INFERÊNCIA DE TAMANHO (seção 2 do pedido): tamanho preferencial
-- = maior SUM(quantity) por (Tipo, tamanho); empate resolvido pelo
-- MAX(sale_date) entre os tamanhos empatados. ROW_NUMBER() OVER (PARTITION
-- BY Tipo ORDER BY quantidade DESC, última_compra DESC) — determinístico.
--
-- EFICIÊNCIA: uma única função SQL (não uma consulta por Tipo), escopada
-- por customer_id + company_id (nunca full-scan da empresa) — chamada 1x
-- por reconciliação, mesmo padrão de computeCustomerCommercialAttributes.
-- STABLE (não SECURITY DEFINER — só leitura, chamada sempre via
-- createAdminClient(), mesmo padrão de mv_customer_rfm/v_cashback_balance
-- já usados em reconciliation.ts).

CREATE OR REPLACE FUNCTION public.rpc_customer_purchase_profile(
  p_customer_id INT,
  p_company_id  INT
)
RETURNS TABLE (
  product_type_slug TEXT,
  product_type_name TEXT,
  total_quantity    BIGINT,
  dominant_size     TEXT
)
LANGUAGE sql
STABLE
SET search_path = public
AS $$
  WITH valid_items AS (
    -- Escopo de tenant real: sales.company_id (confirmado em uso desde a
    -- Fase 4) — não products/product_variations/product_types, que são
    -- alcançados só via JOIN a partir daqui, então já vêm implicitamente
    -- restritos a produtos que esta empresa de fato vendeu.
    SELECT
      si.product_variation_id,
      si.quantity,
      s.sale_date
    FROM public.sale_items si
    JOIN public.sales s ON s.id = si.sale_id
    WHERE s.customer_id = p_customer_id
      AND s.company_id  = p_company_id
      AND s.status NOT IN ('cancelled', 'returned')
  ),
  item_types AS (
    SELECT
      vi.product_variation_id,
      vi.quantity,
      vi.sale_date,
      pt.slug AS product_type_slug,
      pt.name AS product_type_name
    FROM valid_items vi
    JOIN public.product_variations pv ON pv.id = vi.product_variation_id
    JOIN public.products p ON p.id = pv.product_id
    -- products.tipo é o slug normalizado (ver resolve-taxonomy.ts) — junta
    -- direto com product_types.slug, sempre escopado por company_id
    -- (uq_product_types_company_slug garante 1 Tipo por slug+empresa).
    JOIN public.product_types pt ON pt.company_id = p_company_id AND pt.slug = p.tipo
  ),
  item_sizes AS (
    SELECT
      it.product_type_slug,
      it.product_type_name,
      it.quantity,
      it.sale_date,
      (
        SELECT MAX(vv.value) FILTER (WHERE vt.slug = 'tamanho')
        FROM public.product_variation_attributes pva
        JOIN public.variation_types  vt ON vt.id = pva.variation_type_id
        JOIN public.variation_values vv ON vv.id = pva.variation_value_id
        WHERE pva.product_variation_id = it.product_variation_id
      ) AS size_value
    FROM item_types it
  ),
  category_totals AS (
    SELECT
      product_type_slug,
      product_type_name,
      SUM(quantity) AS total_quantity
    FROM item_sizes
    GROUP BY product_type_slug, product_type_name
  ),
  size_totals AS (
    SELECT
      product_type_slug,
      size_value,
      SUM(quantity)  AS size_quantity,
      MAX(sale_date) AS last_purchase_date
    FROM item_sizes
    WHERE size_value IS NOT NULL
    GROUP BY product_type_slug, size_value
  ),
  ranked_sizes AS (
    SELECT
      product_type_slug,
      size_value,
      ROW_NUMBER() OVER (
        PARTITION BY product_type_slug
        ORDER BY size_quantity DESC, last_purchase_date DESC
      ) AS rn
    FROM size_totals
  )
  SELECT
    ct.product_type_slug,
    ct.product_type_name,
    ct.total_quantity,
    rs.size_value AS dominant_size
  FROM category_totals ct
  LEFT JOIN ranked_sizes rs
    ON rs.product_type_slug = ct.product_type_slug AND rs.rn = 1
  ORDER BY ct.product_type_name;
$$;

REVOKE ALL ON FUNCTION public.rpc_customer_purchase_profile(INT, INT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.rpc_customer_purchase_profile(INT, INT) TO service_role;
