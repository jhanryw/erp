-- =============================================================================
-- customer_purchase_profile.test.sql
--
-- Testes FUNCIONAIS pra rpc_customer_purchase_profile (Fase "Enriquecimento
-- comercial" — qarvon_categories/qarvon_size_*) — cobre exatamente os
-- invariantes que não dá pra testar em vitest (agregação real, desempate
-- por MAX(sale_date), exclusão de venda cancelada, isolamento por
-- company_id — tudo depende do Postgres real).
--
-- AVISO IMPORTANTE: `products`, `product_variations`, `sales`, `sale_items`,
-- `variation_types`, `variation_values`, `product_variation_attributes`
-- fazem parte do schema BASE do projeto (anterior a todas as migrations
-- rastreadas neste repositório — não existe um CREATE TABLE consultável
-- pra elas aqui). As colunas usadas abaixo foram reconstruídas por
-- evidência indireta (uso real confirmado em JOINs/INSERTs de outras
-- migrations já aplicadas — ver comentários na migration da RPC,
-- 20260817_rpc_customer_purchase_profile.sql), não por leitura direta do
-- DDL. Se algum INSERT abaixo falhar por coluna ausente/NOT NULL não
-- coberto, ajuste conforme o schema real antes de prosseguir — não é
-- esperado, mas este sandbox não tem acesso pra confirmar 100%.
--
-- COMO RODAR (ambiente de TESTE, nunca produção):
--   psql -v ON_ERROR_STOP=1 "$DATABASE_URL" -f supabase/tests/customer_purchase_profile.test.sql
--
-- Roda inteiro dentro de BEGIN...ROLLBACK — não é destrutivo.
-- =============================================================================

BEGIN;

DO $$
DECLARE
  v_company_a         int;
  v_company_b         int;
  v_customer_a        int;
  v_customer_b        int;
  v_seller             uuid;

  v_pt_pijama          int;
  v_pt_calcinha        int;
  v_pt_sutia           int;

  v_vt_tamanho         int;
  v_vv_m               int;
  v_vv_g               int;
  v_vv_gg              int;
  v_vv_p               int;

  v_prod_pijama        int;
  v_prod_calcinha      int;
  v_prod_sutia         int;

  v_pv_pijama_m        int; -- pijama, tamanho M
  v_pv_calcinha_g      int; -- calcinha, tamanho G
  v_pv_calcinha_gg     int; -- calcinha, tamanho GG
  v_pv_sutia_sem_tam   int; -- sutiã, SEM product_variation_attributes de tamanho (evidência insuficiente)

  v_sale_ok_1          int;
  v_sale_ok_2          int;
  v_sale_ok_recent     int;
  v_sale_cancelled     int;

  v_result             RECORD;
  v_count              int;
BEGIN
  -- ─── Fixtures: 2 empresas temporárias (isoladas, dentro da transação) ───────
  INSERT INTO public.companies (name, slug, plan, active)
  VALUES ('TESTE Purchase Profile A — APAGAR', 'teste-purchase-profile-a-apagar', 'starter', true)
  RETURNING id INTO v_company_a;

  INSERT INTO public.companies (name, slug, plan, active)
  VALUES ('TESTE Purchase Profile B — APAGAR', 'teste-purchase-profile-b-apagar', 'starter', true)
  RETURNING id INTO v_company_b;

  INSERT INTO public.customers (name, cpf, phone, company_id, is_anonymous, active, created_by)
  VALUES ('Cliente Teste A', '11122233344', '84999990001', v_company_a, false, true,
          (SELECT id FROM auth.users LIMIT 1))
  RETURNING id INTO v_customer_a;

  INSERT INTO public.customers (name, cpf, phone, company_id, is_anonymous, active, created_by)
  VALUES ('Cliente Teste B (outra empresa)', '55566677788', '84999990002', v_company_b, false, true,
          (SELECT id FROM auth.users LIMIT 1))
  RETURNING id INTO v_customer_b;

  SELECT id INTO v_seller FROM auth.users LIMIT 1;

  -- ─── product_types (Tipo) — só na empresa A, exceto quando testando isolamento ──
  INSERT INTO public.product_types (company_id, name, slug, active)
  VALUES (v_company_a, 'Pijama', 'pijama', true) RETURNING id INTO v_pt_pijama;
  INSERT INTO public.product_types (company_id, name, slug, active)
  VALUES (v_company_a, 'Calcinha', 'calcinha', true) RETURNING id INTO v_pt_calcinha;
  INSERT INTO public.product_types (company_id, name, slug, active)
  VALUES (v_company_a, 'Sutiã', 'sutia', true) RETURNING id INTO v_pt_sutia;

  -- ─── variation_types/variation_values (tamanho) — compartilhado ────────────
  INSERT INTO public.variation_types (name, slug, kind, active)
  VALUES ('Tamanho', 'tamanho-teste-purchase-profile', 'variant', true)
  RETURNING id INTO v_vt_tamanho;

  INSERT INTO public.variation_values (variation_type_id, value, slug, active)
  VALUES (v_vt_tamanho, 'P', 'p-teste-ppf', true) RETURNING id INTO v_vv_p;
  INSERT INTO public.variation_values (variation_type_id, value, slug, active)
  VALUES (v_vt_tamanho, 'M', 'm-teste-ppf', true) RETURNING id INTO v_vv_m;
  INSERT INTO public.variation_values (variation_type_id, value, slug, active)
  VALUES (v_vt_tamanho, 'G', 'g-teste-ppf', true) RETURNING id INTO v_vv_g;
  INSERT INTO public.variation_values (variation_type_id, value, slug, active)
  VALUES (v_vt_tamanho, 'GG', 'gg-teste-ppf', true) RETURNING id INTO v_vv_gg;

  -- ─── products (categories.category_id é NOT NULL — reaproveita 1 categoria já existente) ──
  INSERT INTO public.products (name, sku, category_id, base_price, active)
  VALUES ('TESTE Pijama PPF', 'TESTE-PPF-PIJ', (SELECT id FROM public.categories LIMIT 1), 100, true)
  RETURNING id INTO v_prod_pijama;
  UPDATE public.products SET tipo = 'pijama' WHERE id = v_prod_pijama;

  INSERT INTO public.products (name, sku, category_id, base_price, active)
  VALUES ('TESTE Calcinha PPF', 'TESTE-PPF-CAL', (SELECT id FROM public.categories LIMIT 1), 50, true)
  RETURNING id INTO v_prod_calcinha;
  UPDATE public.products SET tipo = 'calcinha' WHERE id = v_prod_calcinha;

  INSERT INTO public.products (name, sku, category_id, base_price, active)
  VALUES ('TESTE Sutiã PPF', 'TESTE-PPF-SUT', (SELECT id FROM public.categories LIMIT 1), 80, true)
  RETURNING id INTO v_prod_sutia;
  UPDATE public.products SET tipo = 'sutia' WHERE id = v_prod_sutia;

  -- ─── product_variations + product_variation_attributes (tamanho real) ─────
  INSERT INTO public.product_variations (product_id, sku_variation, active)
  VALUES (v_prod_pijama, 'TESTE-PPF-PIJ-M', true) RETURNING id INTO v_pv_pijama_m;
  INSERT INTO public.product_variation_attributes (product_variation_id, variation_type_id, variation_value_id)
  VALUES (v_pv_pijama_m, v_vt_tamanho, v_vv_m);

  INSERT INTO public.product_variations (product_id, sku_variation, active)
  VALUES (v_prod_calcinha, 'TESTE-PPF-CAL-G', true) RETURNING id INTO v_pv_calcinha_g;
  INSERT INTO public.product_variation_attributes (product_variation_id, variation_type_id, variation_value_id)
  VALUES (v_pv_calcinha_g, v_vt_tamanho, v_vv_g);

  INSERT INTO public.product_variations (product_id, sku_variation, active)
  VALUES (v_prod_calcinha, 'TESTE-PPF-CAL-GG', true) RETURNING id INTO v_pv_calcinha_gg;
  INSERT INTO public.product_variation_attributes (product_variation_id, variation_type_id, variation_value_id)
  VALUES (v_pv_calcinha_gg, v_vt_tamanho, v_vv_gg);

  -- Sutiã SEM product_variation_attributes — "sem tamanho identificável".
  INSERT INTO public.product_variations (product_id, sku_variation, active)
  VALUES (v_prod_sutia, 'TESTE-PPF-SUT-SEMTAM', true) RETURNING id INTO v_pv_sutia_sem_tam;

  -- ─── sales/sale_items ───────────────────────────────────────────────────
  -- Venda 1 (válida, mais antiga): 2x Pijama M, 5x Calcinha G.
  INSERT INTO public.sales (customer_id, seller_id, company_id, status, payment_method, sale_date, total)
  VALUES (v_customer_a, v_seller, v_company_a, 'paid', 'pix', '2026-01-10', 300)
  RETURNING id INTO v_sale_ok_1;
  INSERT INTO public.sale_items (sale_id, product_variation_id, quantity, unit_price, unit_cost, total_price)
  VALUES (v_sale_ok_1, v_pv_pijama_m, 2, 100, 50, 200);
  INSERT INTO public.sale_items (sale_id, product_variation_id, quantity, unit_price, unit_cost, total_price)
  VALUES (v_sale_ok_1, v_pv_calcinha_g, 5, 50, 25, 250);

  -- Venda 2 (válida): 1x Calcinha GG — empate de quantidade NÃO acontece
  -- aqui (G=5 > GG=1), cenário de empate é testado separadamente abaixo.
  INSERT INTO public.sales (customer_id, seller_id, company_id, status, payment_method, sale_date, total)
  VALUES (v_customer_a, v_seller, v_company_a, 'delivered', 'pix', '2026-02-15', 50)
  RETURNING id INTO v_sale_ok_2;
  INSERT INTO public.sale_items (sale_id, product_variation_id, quantity, unit_price, unit_cost, total_price)
  VALUES (v_sale_ok_2, v_pv_calcinha_gg, 1, 50, 25, 50);

  -- Venda 3 (válida, sutiã sem tamanho identificável).
  INSERT INTO public.sales (customer_id, seller_id, company_id, status, payment_method, sale_date, total)
  VALUES (v_customer_a, v_seller, v_company_a, 'paid', 'pix', '2026-03-01', 80)
  RETURNING id INTO v_sale_ok_recent;
  INSERT INTO public.sale_items (sale_id, product_variation_id, quantity, unit_price, unit_cost, total_price)
  VALUES (v_sale_ok_recent, v_pv_sutia_sem_tam, 1, 80, 40, 80);

  -- Venda 4 (CANCELADA) — 10x Pijama M, se contasse mudaria o total_quantity
  -- e poderia até mudar o tamanho dominante. Nunca deve entrar no cálculo.
  INSERT INTO public.sales (customer_id, seller_id, company_id, status, payment_method, sale_date, total)
  VALUES (v_customer_a, v_seller, v_company_a, 'cancelled', 'pix', '2026-04-01', 1000)
  RETURNING id INTO v_sale_cancelled;
  INSERT INTO public.sale_items (sale_id, product_variation_id, quantity, unit_price, unit_cost, total_price)
  VALUES (v_sale_cancelled, v_pv_pijama_m, 10, 100, 50, 1000);

  -- ═══ TESTE 1 — customer sem nenhuma compra: nenhuma linha ═══════════════
  SELECT count(*) INTO v_count
  FROM public.rpc_customer_purchase_profile(v_customer_b, v_company_a);
  IF v_count != 0 THEN
    RAISE EXCEPTION 'TESTE 1 FALHOU: customer sem compras devolveu % linhas, esperado 0', v_count;
  END IF;

  -- ═══ TESTE 2 — múltiplas categorias, venda cancelada ignorada ═══════════
  SELECT count(*) INTO v_count
  FROM public.rpc_customer_purchase_profile(v_customer_a, v_company_a);
  IF v_count != 3 THEN
    RAISE EXCEPTION 'TESTE 2 FALHOU: esperado 3 categorias (pijama/calcinha/sutia), veio %', v_count;
  END IF;

  -- Pijama: só a venda 1 (2 unidades) deveria contar — a venda cancelada
  -- (10 unidades) tem que ser ignorada.
  SELECT total_quantity, dominant_size INTO v_result
  FROM public.rpc_customer_purchase_profile(v_customer_a, v_company_a)
  WHERE product_type_slug = 'pijama';
  IF v_result.total_quantity != 2 THEN
    RAISE EXCEPTION 'TESTE 2 FALHOU: pijama total_quantity = % (esperado 2 — venda cancelada de 10un contaminou o resultado)', v_result.total_quantity;
  END IF;
  IF v_result.dominant_size != 'M' THEN
    RAISE EXCEPTION 'TESTE 2 FALHOU: pijama dominant_size = % (esperado M)', v_result.dominant_size;
  END IF;

  -- ═══ TESTE 3 — tamanho predominante por quantidade (G=5 > GG=1) ═════════
  SELECT total_quantity, dominant_size INTO v_result
  FROM public.rpc_customer_purchase_profile(v_customer_a, v_company_a)
  WHERE product_type_slug = 'calcinha';
  IF v_result.total_quantity != 6 THEN
    RAISE EXCEPTION 'TESTE 3 FALHOU: calcinha total_quantity = % (esperado 6 = 5+1)', v_result.total_quantity;
  END IF;
  IF v_result.dominant_size != 'G' THEN
    RAISE EXCEPTION 'TESTE 3 FALHOU: calcinha dominant_size = % (esperado G, 5un > GG 1un)', v_result.dominant_size;
  END IF;

  -- ═══ TESTE 4 — customer sem tamanho identificável (sutiã) ═══════════════
  SELECT dominant_size INTO v_result
  FROM public.rpc_customer_purchase_profile(v_customer_a, v_company_a)
  WHERE product_type_slug = 'sutia';
  IF v_result.dominant_size IS NOT NULL THEN
    RAISE EXCEPTION 'TESTE 4 FALHOU: sutia dominant_size = % (esperado NULL — nenhuma variação com tamanho cadastrado)', v_result.dominant_size;
  END IF;

  -- ═══ TESTE 5 — isolamento por company_id (empresa B não vê nada da A) ═══
  SELECT count(*) INTO v_count
  FROM public.rpc_customer_purchase_profile(v_customer_a, v_company_b);
  IF v_count != 0 THEN
    RAISE EXCEPTION 'TESTE 5 FALHOU: customer da empresa A consultado com company_id da empresa B devolveu % linhas, esperado 0 (vazamento cross-tenant)', v_count;
  END IF;

  RAISE NOTICE 'TESTES 1-5 (customer_a, sem empate) — TODOS PASSARAM.';
END $$;

-- ═══ TESTE 6 — empate de quantidade resolvido pela compra mais recente ═════
-- Cenário isolado (novo customer/produto) pra não interferir nos testes
-- acima: 2 tamanhos com a MESMA quantidade total, a compra mais recente do
-- tamanho vencedor precisa decidir.
DO $$
DECLARE
  v_company           int;
  v_customer          int;
  v_seller            uuid;
  v_pt                int;
  v_vt                int;
  v_vv_m              int;
  v_vv_g              int;
  v_prod              int;
  v_pv_m              int;
  v_pv_g              int;
  v_sale_m_antiga     int;
  v_sale_g_recente    int;
  v_result            RECORD;
BEGIN
  INSERT INTO public.companies (name, slug, plan, active)
  VALUES ('TESTE Purchase Profile Empate — APAGAR', 'teste-purchase-profile-empate-apagar', 'starter', true)
  RETURNING id INTO v_company;

  INSERT INTO public.customers (name, cpf, phone, company_id, is_anonymous, active, created_by)
  VALUES ('Cliente Teste Empate', '99988877766', '84999990099', v_company, false, true,
          (SELECT id FROM auth.users LIMIT 1))
  RETURNING id INTO v_customer;

  SELECT id INTO v_seller FROM auth.users LIMIT 1;

  INSERT INTO public.product_types (company_id, name, slug, active)
  VALUES (v_company, 'Pijama', 'pijama', true) RETURNING id INTO v_pt;

  INSERT INTO public.variation_types (name, slug, kind, active)
  VALUES ('Tamanho', 'tamanho-teste-empate', 'variant', true) RETURNING id INTO v_vt;
  INSERT INTO public.variation_values (variation_type_id, value, slug, active)
  VALUES (v_vt, 'M', 'm-teste-empate', true) RETURNING id INTO v_vv_m;
  INSERT INTO public.variation_values (variation_type_id, value, slug, active)
  VALUES (v_vt, 'G', 'g-teste-empate', true) RETURNING id INTO v_vv_g;

  INSERT INTO public.products (name, sku, category_id, base_price, active)
  VALUES ('TESTE Pijama Empate', 'TESTE-EMPATE-PIJ', (SELECT id FROM public.categories LIMIT 1), 100, true)
  RETURNING id INTO v_prod;
  UPDATE public.products SET tipo = 'pijama' WHERE id = v_prod;

  INSERT INTO public.product_variations (product_id, sku_variation, active)
  VALUES (v_prod, 'TESTE-EMPATE-PIJ-M', true) RETURNING id INTO v_pv_m;
  INSERT INTO public.product_variation_attributes (product_variation_id, variation_type_id, variation_value_id)
  VALUES (v_pv_m, v_vt, v_vv_m);

  INSERT INTO public.product_variations (product_id, sku_variation, active)
  VALUES (v_prod, 'TESTE-EMPATE-PIJ-G', true) RETURNING id INTO v_pv_g;
  INSERT INTO public.product_variation_attributes (product_variation_id, variation_type_id, variation_value_id)
  VALUES (v_pv_g, v_vt, v_vv_g);

  -- M: 3 unidades, compra ANTIGA (2026-01-05).
  INSERT INTO public.sales (customer_id, seller_id, company_id, status, payment_method, sale_date, total)
  VALUES (v_customer, v_seller, v_company, 'paid', 'pix', '2026-01-05', 300)
  RETURNING id INTO v_sale_m_antiga;
  INSERT INTO public.sale_items (sale_id, product_variation_id, quantity, unit_price, unit_cost, total_price)
  VALUES (v_sale_m_antiga, v_pv_m, 3, 100, 50, 300);

  -- G: também 3 unidades (EMPATE de quantidade), compra MAIS RECENTE (2026-05-20).
  INSERT INTO public.sales (customer_id, seller_id, company_id, status, payment_method, sale_date, total)
  VALUES (v_customer, v_seller, v_company, 'paid', 'pix', '2026-05-20', 300)
  RETURNING id INTO v_sale_g_recente;
  INSERT INTO public.sale_items (sale_id, product_variation_id, quantity, unit_price, unit_cost, total_price)
  VALUES (v_sale_g_recente, v_pv_g, 3, 100, 50, 300);

  SELECT dominant_size INTO v_result
  FROM public.rpc_customer_purchase_profile(v_customer, v_company)
  WHERE product_type_slug = 'pijama';

  IF v_result.dominant_size != 'G' THEN
    RAISE EXCEPTION 'TESTE 6 FALHOU: empate M=3/G=3 deveria resolver pra G (compra mais recente, 2026-05-20 > 2026-01-05), veio %', v_result.dominant_size;
  END IF;

  RAISE NOTICE 'TESTE 6 (empate resolvido pela compra mais recente) — PASSOU.';
END $$;

ROLLBACK;

-- =============================================================================
-- FIM DOS TESTES — nenhuma linha permanece (ROLLBACK acima desfaz tudo,
-- inclusive as empresas/customers/produtos temporários).
-- =============================================================================
