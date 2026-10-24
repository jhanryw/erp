-- =============================================================================
-- import_fiscal_roundtrip.test.sql
-- Prova de persistência de NCM (com zero à esquerda) e origem fiscal 0 em:
-- criação (rpc_import_products_batch), atualização por SKU
-- (rpc_update_products_by_sku_batch) e "reimportação" (update repetido/sem
-- colunas fiscais). Não destrutivo: BEGIN...ROLLBACK. Somente ambiente de TESTE.
--   PGOPTIONS='-c app.stock_rpc=1' psql -v ON_ERROR_STOP=1 "$DATABASE_URL" -f supabase/tests/import_fiscal_roundtrip.test.sql
-- =============================================================================
BEGIN;

INSERT INTO public.categories (name, slug, company_id, active)
VALUES ('TESTE Fiscal Roundtrip — APAGAR', 'teste-fiscal-roundtrip-apagar', 1, true)
ON CONFLICT DO NOTHING;

DO $$
DECLARE
  v_cat INT; v_user UUID; v_res JSONB; v_pid INT; v_vid1 INT; v_vid2 INT; v_sku1 TEXT;
  v_ncm TEXT; v_orig SMALLINT; v_cst TEXT; v_price NUMERIC;
BEGIN
  SELECT id INTO v_cat FROM public.categories WHERE slug = 'teste-fiscal-roundtrip-apagar';
  SELECT id INTO v_user FROM public.users WHERE company_id = 1 AND role IN ('admin','gerente') AND active LIMIT 1;
  IF v_user IS NULL THEN RAISE EXCEPTION 'Sem admin/gerente na empresa 1.'; END IF;

  -- 1. CRIAÇÃO com NCM iniciado por zero + origem 0 + 2 variações
  v_res := public.rpc_import_products_batch(1, v_user, jsonb_build_array(jsonb_build_object(
    'client_index',0,'name','Produto Fiscal Roundtrip','tipo','x','modelo','y','ano','2026',
    'category_id',v_cat,'origin','third_party','base_cost',10,'base_price',50,'active',true,
    'sku_base','TESTE-FISCAL-RT-0001','sku_scheme','legacy',
    'ncm','09012100','origem',0,'cst','060',
    'variants', jsonb_build_array(
      jsonb_build_object('client_index',0,'sku_base','TESTE-FISCAL-RT-0001-V1','initial_stock',0),
      jsonb_build_object('client_index',1,'sku_base','TESTE-FISCAL-RT-0001-V2','initial_stock',0))
  )), NULL);
  v_pid  := ((v_res->'products'->0)->>'id')::int;
  v_vid1 := (v_res->'products'->0->'variants'->0->>'id')::int;
  v_vid2 := (v_res->'products'->0->'variants'->1->>'id')::int;
  SELECT ncm, origem INTO v_ncm, v_orig FROM public.products WHERE id = v_pid;
  IF v_ncm IS DISTINCT FROM '09012100' THEN RAISE EXCEPTION 'FALHA (1): NCM com zero à esquerda: veio %', v_ncm; END IF;
  IF v_orig IS DISTINCT FROM 0::smallint THEN RAISE EXCEPTION 'FALHA (1): origem 0: veio %', v_orig; END IF;
  RAISE NOTICE 'OK (1): criação persiste NCM 09012100 e origem 0.';

  SELECT sku_variation INTO v_sku1 FROM public.product_variations WHERE id = v_vid1;

  -- 2. UPDATE por SKU só de preço (sem chaves fiscais): fiscal preservado
  PERFORM public.rpc_update_products_by_sku_batch(1, v_user,
    jsonb_build_array(jsonb_build_object('client_index',0,'sku',v_sku1,'price_override',55)), NULL);
  SELECT ncm, origem, cst INTO v_ncm, v_orig, v_cst FROM public.products WHERE id = v_pid;
  IF v_ncm IS DISTINCT FROM '09012100' OR v_orig IS DISTINCT FROM 0::smallint OR v_cst IS DISTINCT FROM '060' THEN
    RAISE EXCEPTION 'FALHA (2): update sem colunas fiscais alterou o fiscal: %/%/%', v_ncm, v_orig, v_cst; END IF;
  RAISE NOTICE 'OK (2): update sem chaves fiscais preserva NCM/origem/CST.';

  -- 3. UPDATE só de NCM: origem 0 preservada (0 não é tratado como "vazio")
  PERFORM public.rpc_update_products_by_sku_batch(1, v_user,
    jsonb_build_array(jsonb_build_object('client_index',0,'sku',v_sku1,'ncm','06029090')), NULL);
  SELECT ncm, origem INTO v_ncm, v_orig FROM public.products WHERE id = v_pid;
  IF v_ncm IS DISTINCT FROM '06029090' OR v_orig IS DISTINCT FROM 0::smallint THEN
    RAISE EXCEPTION 'FALHA (3): update de NCM: %/%', v_ncm, v_orig; END IF;
  RAISE NOTICE 'OK (3): update só de NCM (zero à esquerda) mantém origem 0.';

  -- 4. REIMPORTAÇÃO idempotente (mesmos valores via variação 2) e origem 0 -> 2 -> 0
  PERFORM public.rpc_update_products_by_sku_batch(1, v_user,
    jsonb_build_array(jsonb_build_object('client_index',0,'sku',(SELECT sku_variation FROM public.product_variations WHERE id=v_vid2),'origem',2)), NULL);
  SELECT origem INTO v_orig FROM public.products WHERE id = v_pid;
  IF v_orig IS DISTINCT FROM 2::smallint THEN RAISE EXCEPTION 'FALHA (4a): origem 2: %', v_orig; END IF;
  PERFORM public.rpc_update_products_by_sku_batch(1, v_user,
    jsonb_build_array(jsonb_build_object('client_index',0,'sku',v_sku1,'origem',0,'ncm','06029090')), NULL);
  SELECT ncm, origem INTO v_ncm, v_orig FROM public.products WHERE id = v_pid;
  IF v_ncm IS DISTINCT FROM '06029090' OR v_orig IS DISTINCT FROM 0::smallint THEN
    RAISE EXCEPTION 'FALHA (4b): reimportação: %/%', v_ncm, v_orig; END IF;
  RAISE NOTICE 'OK (4): reimportação/alteração por SKU persiste origem 0 e NCM com zero à esquerda; fiscal é do produto (vale para as 2 variações).';

  -- 5. NCM inválido no update é rejeitado e não altera nada
  v_res := public.rpc_update_products_by_sku_batch(1, v_user,
    jsonb_build_array(jsonb_build_object('client_index',0,'sku',v_sku1,'ncm','6109')), NULL);
  SELECT ncm INTO v_ncm FROM public.products WHERE id = v_pid;
  IF v_ncm IS DISTINCT FROM '06029090' THEN RAISE EXCEPTION 'FALHA (5): NCM inválido alterou o valor: %', v_ncm; END IF;
  RAISE NOTICE 'OK (5): NCM inválido não altera o valor persistido.';
END $$;

ROLLBACK;
