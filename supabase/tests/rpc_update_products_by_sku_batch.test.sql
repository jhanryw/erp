-- =============================================================================
-- rpc_update_products_by_sku_batch.test.sql
--
-- Conclusão da fundação varejo/atacado — UPDATE de produto/variação
-- existente por SKU (product_variations.sku_variation). Continuação de
-- supabase/tests/rpc_import_products_batch_wholesale_fiscal.test.sql, que
-- só cobria CREATE.
--
-- COMO RODAR (ambiente de TESTE, nunca produção):
--   psql -v ON_ERROR_STOP=1 "$DATABASE_URL" -f supabase/tests/rpc_update_products_by_sku_batch.test.sql
--
-- Roda inteiro dentro de BEGIN...ROLLBACK — não é destrutivo.
-- =============================================================================

BEGIN;

INSERT INTO public.categories (name, slug, company_id, active)
VALUES ('TESTE Update SKU — APAGAR', 'teste-update-sku-apagar', 1, true)
ON CONFLICT DO NOTHING;

-- Segunda empresa, pra provar isolamento multi-tenant (teste 3)
INSERT INTO public.companies (name, slug, plan)
SELECT 'TESTE UPDATE SKU OUTRA EMPRESA', 'teste-update-sku-outra-empresa', plan
FROM public.companies LIMIT 1
ON CONFLICT DO NOTHING;

DO $$
DECLARE
  v_category_id   INT;
  v_test_user_id  UUID;
  v_other_company_id INT;
  v_other_user_id UUID;
  v_product_a_id  INT;
  v_variation_a_id INT;
  v_product_b_id  INT;
  v_variation_b_id INT;
  v_variation_other_company_id INT;
  v_result        JSONB;
  v_wholesale     NUMERIC;
  v_price_ovr     NUMERIC;
  v_ncm           TEXT;
  v_origem        SMALLINT;
  v_cst           TEXT;
  v_base_price    NUMERIC;
BEGIN
  SELECT id INTO v_category_id FROM public.categories WHERE slug = 'teste-update-sku-apagar';

  SELECT id INTO v_test_user_id
  FROM public.users
  WHERE company_id = 1 AND role IN ('admin', 'gerente', 'usuario') AND active = true
  LIMIT 1;

  IF v_test_user_id IS NULL THEN
    RAISE NOTICE 'PULADO: nenhum usuário ativo encontrado para company_id=1.';
    RETURN;
  END IF;

  SELECT id INTO v_other_company_id FROM public.companies WHERE slug = 'teste-update-sku-outra-empresa';
  SELECT id INTO v_other_user_id FROM public.users WHERE company_id != 1 AND active = true LIMIT 1;

  -- ── Fixture: produto A com preços/fiscal já cadastrados ──────────────────
  INSERT INTO public.products (name, sku, category_id, company_id, tipo, modelo, ano, base_cost, base_price, wholesale_price, ncm, origem, cst, active)
  VALUES ('Produto Teste Update A', 'TESTE-UPD-A', v_category_id, 1, 'x', 'y', '2026', 30, 69.90, 49.90, '61082200', 0, '060', true)
  RETURNING id INTO v_product_a_id;

  INSERT INTO public.product_variations (product_id, sku_variation, active)
  VALUES (v_product_a_id, 'TESTE-UPD-A-V1', true)
  RETURNING id INTO v_variation_a_id;

  -- Segundo produto/variação, pra testes de múltiplas linhas (teste 19)
  INSERT INTO public.products (name, sku, category_id, company_id, tipo, modelo, ano, base_cost, base_price, active)
  VALUES ('Produto Teste Update B', 'TESTE-UPD-B', v_category_id, 1, 'x', 'y', '2026', 20, 39.90, true)
  RETURNING id INTO v_product_b_id;

  INSERT INTO public.product_variations (product_id, sku_variation, active)
  VALUES (v_product_b_id, 'TESTE-UPD-B-V1', true)
  RETURNING id INTO v_variation_b_id;

  -- Variação em OUTRA empresa com o MESMO valor de sku_variation — prova
  -- que o lookup nunca vaza cross-tenant (teste 3 / "nunca faça lookup só
  -- por sku_variation = X").
  IF v_other_company_id IS NOT NULL THEN
    INSERT INTO public.products (name, sku, category_id, company_id, tipo, modelo, ano, base_cost, base_price, active)
    VALUES ('Produto Outra Empresa', 'TESTE-UPD-OTHER', (SELECT id FROM categories WHERE company_id = v_other_company_id OR company_id IS NULL LIMIT 1), v_other_company_id, 'x', 'y', '2026', 10, 20, true)
    RETURNING id INTO v_variation_other_company_id; -- reaproveita a var pra guardar product_id temporariamente

    INSERT INTO public.product_variations (product_id, sku_variation, active)
    VALUES (v_variation_other_company_id, 'TESTE-UPD-CROSS-TENANT', true)
    RETURNING id INTO v_variation_other_company_id;
  END IF;

  -- ═══════════════════════════════════════════════════════════════════════
  -- TESTE 2 — atualiza SKU existente (preço varejo + atacado + NCM +
  -- origem + CST, tudo de uma vez) — via a RPC de lote.
  -- ═══════════════════════════════════════════════════════════════════════
  v_result := public.rpc_update_products_by_sku_batch(
    1, v_test_user_id,
    jsonb_build_array(jsonb_build_object(
      'client_index', 0,
      'sku', 'TESTE-UPD-A-V1',
      'price_override', 65.00,
      'wholesale_price_override', 45.00,
      'ncm', '61091000',
      'origem', 2,
      'cst', '040'
    )),
    NULL
  );

  IF (v_result->>'updated')::int <> 1 THEN
    RAISE EXCEPTION 'FALHA (teste 2): esperado updated=1, veio %.', v_result->>'updated';
  END IF;

  SELECT price_override, wholesale_price_override INTO v_price_ovr, v_wholesale
  FROM public.product_variations WHERE id = v_variation_a_id;
  SELECT ncm, origem, cst INTO v_ncm, v_origem, v_cst FROM public.products WHERE id = v_product_a_id;

  IF v_price_ovr IS DISTINCT FROM 65.00 THEN RAISE EXCEPTION 'FALHA (teste 2): price_override esperado 65.00, veio %.', v_price_ovr; END IF;
  IF v_wholesale IS DISTINCT FROM 45.00 THEN RAISE EXCEPTION 'FALHA (teste 2): wholesale_price_override esperado 45.00, veio %.', v_wholesale; END IF;
  IF v_ncm IS DISTINCT FROM '61091000' THEN RAISE EXCEPTION 'FALHA (teste 2): ncm esperado 61091000, veio %.', v_ncm; END IF;
  IF v_origem IS DISTINCT FROM 2::smallint THEN RAISE EXCEPTION 'FALHA (teste 2): origem esperado 2, veio %.', v_origem; END IF;
  IF v_cst IS DISTINCT FROM '040' THEN RAISE EXCEPTION 'FALHA (teste 2): cst esperado 040, veio %.', v_cst; END IF;

  RAISE NOTICE 'OK (teste 2): update por SKU existente altera todos os campos enviados.';

  -- ═══════════════════════════════════════════════════════════════════════
  -- TESTE 5 — célula vazia (chave AUSENTE do patch) preserva valor anterior.
  -- Envia só wholesale_price_override — ncm/origem/cst/price_override
  -- (varejo) devem continuar exatamente como o teste 2 deixou.
  -- ═══════════════════════════════════════════════════════════════════════
  v_result := public.rpc_update_products_by_sku_batch(
    1, v_test_user_id,
    jsonb_build_array(jsonb_build_object('client_index', 0, 'sku', 'TESTE-UPD-A-V1', 'wholesale_price_override', 47.90)),
    NULL
  );

  SELECT price_override, wholesale_price_override INTO v_price_ovr, v_wholesale
  FROM public.product_variations WHERE id = v_variation_a_id;
  SELECT ncm, origem, cst INTO v_ncm, v_origem, v_cst FROM public.products WHERE id = v_product_a_id;

  IF v_wholesale IS DISTINCT FROM 47.90 THEN
    RAISE EXCEPTION 'FALHA (teste 5): wholesale_price_override deveria ter mudado pra 47.90, veio %.', v_wholesale;
  END IF;
  -- Os demais campos, cujas chaves NÃO foram enviadas, precisam ter
  -- sobrevivido intactos do teste 2 — esta é a prova central da regra
  -- "célula vazia nunca apaga".
  IF v_price_ovr IS DISTINCT FROM 65.00 THEN
    RAISE EXCEPTION 'FALHA (teste 5): price_override (varejo) deveria continuar 65.00 (campo não enviado), veio %.', v_price_ovr;
  END IF;
  IF v_ncm IS DISTINCT FROM '61091000' THEN
    RAISE EXCEPTION 'FALHA (teste 5): ncm deveria continuar 61091000 (campo não enviado), veio %.', v_ncm;
  END IF;
  IF v_origem IS DISTINCT FROM 2::smallint THEN
    RAISE EXCEPTION 'FALHA (teste 5): origem deveria continuar 2 (campo não enviado), veio %.', v_origem;
  END IF;
  IF v_cst IS DISTINCT FROM '040' THEN
    RAISE EXCEPTION 'FALHA (teste 5): cst deveria continuar 040 (campo não enviado), veio %.', v_cst;
  END IF;

  RAISE NOTICE 'OK (teste 5): célula vazia (chave ausente) nunca apaga valor já cadastrado — só o campo enviado mudou.';

  -- ═══════════════════════════════════════════════════════════════════════
  -- TESTE 6/7 — preço de varejo altera SÓ varejo; preço de atacado altera
  -- SÓ atacado (nunca um mexe no outro) — já implícito nos testes 2/5, mas
  -- aqui de forma isolada e explícita.
  -- ═══════════════════════════════════════════════════════════════════════
  PERFORM public.rpc_update_products_by_sku_batch(
    1, v_test_user_id,
    jsonb_build_array(jsonb_build_object('client_index', 0, 'sku', 'TESTE-UPD-A-V1', 'price_override', 70.00)),
    NULL
  );
  SELECT price_override, wholesale_price_override INTO v_price_ovr, v_wholesale
  FROM public.product_variations WHERE id = v_variation_a_id;
  IF v_price_ovr IS DISTINCT FROM 70.00 THEN RAISE EXCEPTION 'FALHA (teste 6): price_override deveria ser 70.00.'; END IF;
  IF v_wholesale IS DISTINCT FROM 47.90 THEN RAISE EXCEPTION 'FALHA (teste 6): atualizar preço de varejo NÃO deveria alterar wholesale_price_override, veio %.', v_wholesale; END IF;
  RAISE NOTICE 'OK (teste 6): atualizar preço de varejo altera só varejo.';

  PERFORM public.rpc_update_products_by_sku_batch(
    1, v_test_user_id,
    jsonb_build_array(jsonb_build_object('client_index', 0, 'sku', 'TESTE-UPD-A-V1', 'wholesale_price_override', 48.00)),
    NULL
  );
  SELECT price_override, wholesale_price_override INTO v_price_ovr, v_wholesale
  FROM public.product_variations WHERE id = v_variation_a_id;
  IF v_wholesale IS DISTINCT FROM 48.00 THEN RAISE EXCEPTION 'FALHA (teste 7): wholesale_price_override deveria ser 48.00.'; END IF;
  IF v_price_ovr IS DISTINCT FROM 70.00 THEN RAISE EXCEPTION 'FALHA (teste 7): atualizar preço de atacado NÃO deveria alterar price_override (varejo), veio %.', v_price_ovr; END IF;
  RAISE NOTICE 'OK (teste 7): atualizar preço de atacado altera só atacado.';

  -- ═══════════════════════════════════════════════════════════════════════
  -- TESTE 8 — preço por variação atualiza a VARIAÇÃO (price_override/
  -- wholesale_price_override), NUNCA products.base_price/wholesale_price
  -- do produto-pai (que continuam do valor de cadastro original: 69.90/49.90).
  -- ═══════════════════════════════════════════════════════════════════════
  SELECT base_price, wholesale_price INTO v_base_price, v_wholesale FROM public.products WHERE id = v_product_a_id;
  IF v_base_price IS DISTINCT FROM 69.90 THEN
    RAISE EXCEPTION 'FALHA (teste 8): base_price do produto-pai NUNCA deveria ter mudado (updates só tocam a variação), veio %.', v_base_price;
  END IF;
  IF v_wholesale IS DISTINCT FROM 49.90 THEN
    RAISE EXCEPTION 'FALHA (teste 8): wholesale_price do produto-pai NUNCA deveria ter mudado (updates só tocam a variação), veio %.', v_wholesale;
  END IF;
  RAISE NOTICE 'OK (teste 8): preços por variação nunca vazam pro produto-pai (base_price/wholesale_price intactos).';

  -- ═══════════════════════════════════════════════════════════════════════
  -- TESTE 9/10/11 — NCM válido, NCM com pontuação normalizado (rejeitado
  -- se vier com pontuação — a normalização é feita no Node/parser antes de
  -- chegar aqui; o RPC exige só dígitos) e NCM inválido rejeitado SEM
  -- alterar o registro (atomicidade — teste 17 também cobre isso).
  -- ═══════════════════════════════════════════════════════════════════════
  PERFORM public.rpc_update_products_by_sku_batch(
    1, v_test_user_id,
    jsonb_build_array(jsonb_build_object('client_index', 0, 'sku', 'TESTE-UPD-A-V1', 'ncm', '12345678')),
    NULL
  );
  SELECT ncm INTO v_ncm FROM public.products WHERE id = v_product_a_id;
  IF v_ncm IS DISTINCT FROM '12345678' THEN RAISE EXCEPTION 'FALHA (teste 9): NCM válido deveria ter persistido.'; END IF;
  RAISE NOTICE 'OK (teste 9): NCM válido (8 dígitos) persiste.';

  BEGIN
    PERFORM public.rpc_update_products_by_sku_batch(
      1, v_test_user_id,
      jsonb_build_array(jsonb_build_object('client_index', 0, 'sku', 'TESTE-UPD-A-V1', 'ncm', '6108.22.00')),
      NULL
    );
    RAISE EXCEPTION 'FALHA (teste 10): NCM com pontuação deveria ter sido rejeitado pelo RPC (normalização é responsabilidade do Node).';
  EXCEPTION
    WHEN OTHERS THEN
      IF SQLERRM LIKE '%NCM inválido%' THEN
        RAISE NOTICE 'OK (teste 10): NCM com pontuação rejeitado pelo RPC (a normalização acontece antes, no parser Node).';
      ELSE RAISE; END IF;
  END;

  BEGIN
    PERFORM public.rpc_update_products_by_sku_batch(
      1, v_test_user_id,
      jsonb_build_array(jsonb_build_object('client_index', 0, 'sku', 'TESTE-UPD-A-V1', 'ncm', '123')),
      NULL
    );
    RAISE EXCEPTION 'FALHA (teste 11): NCM inválido deveria ter sido rejeitado.';
  EXCEPTION
    WHEN OTHERS THEN
      IF SQLERRM LIKE '%NCM inválido%' THEN
        RAISE NOTICE 'OK (teste 11): NCM inválido rejeitado.';
      ELSE RAISE; END IF;
  END;

  SELECT ncm INTO v_ncm FROM public.products WHERE id = v_product_a_id;
  IF v_ncm IS DISTINCT FROM '12345678' THEN
    RAISE EXCEPTION 'FALHA (teste 11): NCM inválido rejeitado NÃO deveria ter alterado o registro — esperado continuar 12345678, veio %.', v_ncm;
  END IF;
  RAISE NOTICE 'OK (teste 11 cont.): registro não foi alterado por um NCM inválido rejeitado.';

  -- ═══════════════════════════════════════════════════════════════════════
  -- TESTE 12/13 — origem fiscal válida (0-8) e inválida (fora da faixa).
  -- ═══════════════════════════════════════════════════════════════════════
  PERFORM public.rpc_update_products_by_sku_batch(
    1, v_test_user_id,
    jsonb_build_array(jsonb_build_object('client_index', 0, 'sku', 'TESTE-UPD-A-V1', 'origem', 5)),
    NULL
  );
  SELECT origem INTO v_origem FROM public.products WHERE id = v_product_a_id;
  IF v_origem IS DISTINCT FROM 5::smallint THEN RAISE EXCEPTION 'FALHA (teste 12): origem válida (5) deveria ter persistido.'; END IF;
  RAISE NOTICE 'OK (teste 12): origem fiscal válida persiste.';

  BEGIN
    PERFORM public.rpc_update_products_by_sku_batch(
      1, v_test_user_id,
      jsonb_build_array(jsonb_build_object('client_index', 0, 'sku', 'TESTE-UPD-A-V1', 'origem', 99)),
      NULL
    );
    RAISE EXCEPTION 'FALHA (teste 13): origem inválida (99) deveria ter sido rejeitada.';
  EXCEPTION
    WHEN OTHERS THEN
      IF SQLERRM LIKE '%Origem fiscal inválida%' THEN
        RAISE NOTICE 'OK (teste 13): origem fiscal inválida rejeitada.';
      ELSE RAISE; END IF;
  END;

  -- ═══════════════════════════════════════════════════════════════════════
  -- TESTE 14 — CST válido (texto livre, sem validação de formato — mesma
  -- política da criação, ver comentário de products.cst).
  -- ═══════════════════════════════════════════════════════════════════════
  PERFORM public.rpc_update_products_by_sku_batch(
    1, v_test_user_id,
    jsonb_build_array(jsonb_build_object('client_index', 0, 'sku', 'TESTE-UPD-A-V1', 'cst', '500')),
    NULL
  );
  SELECT cst INTO v_cst FROM public.products WHERE id = v_product_a_id;
  IF v_cst IS DISTINCT FROM '500' THEN RAISE EXCEPTION 'FALHA (teste 14): CST deveria ter persistido como 500.'; END IF;
  RAISE NOTICE 'OK (teste 14): CST (texto livre) persiste sem validação de formato.';

  -- ═══════════════════════════════════════════════════════════════════════
  -- TESTE 16 — valor negativo rejeitado (preço varejo e atacado).
  -- ═══════════════════════════════════════════════════════════════════════
  BEGIN
    PERFORM public.rpc_update_products_by_sku_batch(
      1, v_test_user_id,
      jsonb_build_array(jsonb_build_object('client_index', 0, 'sku', 'TESTE-UPD-A-V1', 'price_override', -10)),
      NULL
    );
    RAISE EXCEPTION 'FALHA (teste 16): preço de varejo negativo deveria ter sido rejeitado.';
  EXCEPTION
    WHEN OTHERS THEN
      IF SQLERRM LIKE '%Preço de varejo inválido%' THEN
        RAISE NOTICE 'OK (teste 16a): preço de varejo negativo rejeitado.';
      ELSE RAISE; END IF;
  END;

  BEGIN
    PERFORM public.rpc_update_products_by_sku_batch(
      1, v_test_user_id,
      jsonb_build_array(jsonb_build_object('client_index', 0, 'sku', 'TESTE-UPD-A-V1', 'wholesale_price_override', -5)),
      NULL
    );
    RAISE EXCEPTION 'FALHA (teste 16b): preço de atacado negativo deveria ter sido rejeitado.';
  EXCEPTION
    WHEN OTHERS THEN
      IF SQLERRM LIKE '%Preço de atacado inválido%' THEN
        RAISE NOTICE 'OK (teste 16b): preço de atacado negativo rejeitado.';
      ELSE RAISE; END IF;
  END;

  -- ═══════════════════════════════════════════════════════════════════════
  -- TESTE 17 — linha com um campo válido + um campo inválido NÃO fica
  -- parcialmente aplicada (atomicidade por linha real, não só por savepoint
  -- do chamador — _update_single_product_by_sku valida TUDO antes de
  -- escrever qualquer coisa).
  -- ═══════════════════════════════════════════════════════════════════════
  SELECT wholesale_price_override INTO v_wholesale FROM public.product_variations WHERE id = v_variation_a_id;
  BEGIN
    PERFORM public._update_single_product_by_sku(
      1, 'TESTE-UPD-A-V1',
      jsonb_build_object('wholesale_price_override', 99.99, 'ncm', 'INVALIDO')
    );
    RAISE EXCEPTION 'FALHA (teste 17): linha com NCM inválido deveria ter sido rejeitada inteira.';
  EXCEPTION
    WHEN OTHERS THEN
      IF SQLERRM LIKE '%NCM inválido%' THEN
        RAISE NOTICE 'OK (teste 17): linha rejeitada por completo (NCM inválido barrou a função antes de qualquer UPDATE).';
      ELSE RAISE; END IF;
  END;
  -- Confirma que o campo VÁLIDO da mesma linha (wholesale_price_override)
  -- NÃO foi aplicado — prova de que não ficou "meio aplicado".
  DECLARE
    v_wholesale_after NUMERIC;
  BEGIN
    SELECT wholesale_price_override INTO v_wholesale_after FROM public.product_variations WHERE id = v_variation_a_id;
    IF v_wholesale_after IS DISTINCT FROM v_wholesale THEN
      RAISE EXCEPTION 'FALHA (teste 17 cont.): wholesale_price_override não deveria ter mudado (linha inteira rejeitada), era % agora é %.', v_wholesale, v_wholesale_after;
    END IF;
  END;
  RAISE NOTICE 'OK (teste 17 cont.): nenhum campo da linha rejeitada foi persistido — atomicidade por linha confirmada.';

  -- ═══════════════════════════════════════════════════════════════════════
  -- TESTE 19 — múltiplas linhas atualizando produtos DIFERENTES no mesmo lote.
  -- ═══════════════════════════════════════════════════════════════════════
  v_result := public.rpc_update_products_by_sku_batch(
    1, v_test_user_id,
    jsonb_build_array(
      jsonb_build_object('client_index', 0, 'sku', 'TESTE-UPD-A-V1', 'price_override', 71.00),
      jsonb_build_object('client_index', 1, 'sku', 'TESTE-UPD-B-V1', 'price_override', 41.00)
    ),
    NULL
  );
  IF (v_result->>'updated')::int <> 2 THEN
    RAISE EXCEPTION 'FALHA (teste 19): esperado updated=2 (duas linhas, dois produtos), veio %.', v_result->>'updated';
  END IF;
  SELECT price_override INTO v_price_ovr FROM public.product_variations WHERE id = v_variation_b_id;
  IF v_price_ovr IS DISTINCT FROM 41.00 THEN
    RAISE EXCEPTION 'FALHA (teste 19): produto B deveria ter sido atualizado independentemente, price_override esperado 41.00, veio %.', v_price_ovr;
  END IF;
  RAISE NOTICE 'OK (teste 19): múltiplas linhas atualizam produtos diferentes corretamente no mesmo lote.';

  -- ═══════════════════════════════════════════════════════════════════════
  -- TESTE 1 (SKU inexistente) + parcial-sucesso do lote: um lote com uma
  -- linha válida (produto B) e uma linha com SKU inexistente reporta
  -- updated=1 + 1 erro — a linha ruim NÃO aborta a boa (diferente de
  -- rpc_import_products_batch/CREATE, que continua all-or-nothing).
  -- ═══════════════════════════════════════════════════════════════════════
  v_result := public.rpc_update_products_by_sku_batch(
    1, v_test_user_id,
    jsonb_build_array(
      jsonb_build_object('client_index', 0, 'sku', 'TESTE-UPD-B-V1', 'price_override', 42.00),
      jsonb_build_object('client_index', 1, 'sku', 'SKU-QUE-NAO-EXISTE-JAMAIS', 'price_override', 10.00)
    ),
    NULL
  );
  IF (v_result->>'updated')::int <> 1 THEN
    RAISE EXCEPTION 'FALHA (teste 1): esperado updated=1 (só a linha válida), veio %.', v_result->>'updated';
  END IF;
  IF jsonb_array_length(v_result->'errors') <> 1 THEN
    RAISE EXCEPTION 'FALHA (teste 1): esperado exatamente 1 erro (SKU inexistente), veio %.', jsonb_array_length(v_result->'errors');
  END IF;
  IF (v_result->'errors'->0->>'message') NOT LIKE '%não encontrado%' THEN
    RAISE EXCEPTION 'FALHA (teste 1): mensagem de erro deveria mencionar "não encontrado", veio "%".', v_result->'errors'->0->>'message';
  END IF;
  SELECT price_override INTO v_price_ovr FROM public.product_variations WHERE id = v_variation_b_id;
  IF v_price_ovr IS DISTINCT FROM 42.00 THEN
    RAISE EXCEPTION 'FALHA (teste 1 cont.): a linha válida do lote deveria ter sido aplicada mesmo com a outra linha falhando.';
  END IF;
  RAISE NOTICE 'OK (teste 1 + parcial-sucesso): SKU inexistente gera erro POR LINHA sem abortar o lote inteiro — linha válida foi aplicada.';

  -- ═══════════════════════════════════════════════════════════════════════
  -- TESTE 20 — SKU ambíguo dentro do PRÓPRIO CSV (mesmo sku duas vezes no
  -- lote) — a segunda ocorrência falha explicitamente, nunca escolhe
  -- arbitrariamente qual "vale".
  -- ═══════════════════════════════════════════════════════════════════════
  v_result := public.rpc_update_products_by_sku_batch(
    1, v_test_user_id,
    jsonb_build_array(
      jsonb_build_object('client_index', 0, 'sku', 'TESTE-UPD-B-V1', 'price_override', 43.00),
      jsonb_build_object('client_index', 1, 'sku', 'TESTE-UPD-B-V1', 'price_override', 44.00)
    ),
    NULL
  );
  IF (v_result->>'updated')::int <> 1 THEN
    RAISE EXCEPTION 'FALHA (teste 20): esperado updated=1 (só a primeira ocorrência), veio %.', v_result->>'updated';
  END IF;
  IF jsonb_array_length(v_result->'errors') <> 1 THEN
    RAISE EXCEPTION 'FALHA (teste 20): esperado 1 erro (SKU duplicado dentro do CSV), veio %.', jsonb_array_length(v_result->'errors');
  END IF;
  IF (v_result->'errors'->0->>'message') NOT LIKE '%duplicado%' THEN
    RAISE EXCEPTION 'FALHA (teste 20): mensagem deveria mencionar "duplicado", veio "%".', v_result->'errors'->0->>'message';
  END IF;
  SELECT price_override INTO v_price_ovr FROM public.product_variations WHERE id = v_variation_b_id;
  IF v_price_ovr IS DISTINCT FROM 43.00 THEN
    RAISE EXCEPTION 'FALHA (teste 20 cont.): a PRIMEIRA ocorrência deveria ter sido aplicada (43.00), veio %.', v_price_ovr;
  END IF;
  RAISE NOTICE 'OK (teste 20): SKU duplicado dentro do CSV — primeira ocorrência aplicada, segunda reportada como erro explícito.';

  -- ═══════════════════════════════════════════════════════════════════════
  -- Ambiguidade CONTRA O BANCO (2 variações com o mesmo sku_variation na
  -- mesma empresa) — cenário defensivo, não deveria acontecer na prática
  -- (sku_variation é tratado como único pela aplicação), mas o RPC precisa
  -- recusar em vez de escolher arbitrariamente se acontecer.
  -- ═══════════════════════════════════════════════════════════════════════
  BEGIN
    INSERT INTO public.product_variations (product_id, sku_variation, active)
    VALUES (v_product_b_id, 'TESTE-UPD-B-V1', true); -- mesmo sku_variation do fixture acima, de propósito

    BEGIN
      PERFORM public._update_single_product_by_sku(1, 'TESTE-UPD-B-V1', jsonb_build_object('price_override', 1));
      RAISE EXCEPTION 'FALHA (ambiguidade DB): deveria ter sido rejeitado por ambiguidade.';
    EXCEPTION
      WHEN OTHERS THEN
        IF SQLERRM LIKE '%ambíguo%' THEN
          RAISE NOTICE 'OK (ambiguidade DB): 2 variações com mesmo SKU na mesma empresa → erro explícito de ambiguidade, nunca escolha arbitrária.';
        ELSE RAISE; END IF;
    END;
  END;

  -- ═══════════════════════════════════════════════════════════════════════
  -- TESTE 3 — multi-tenancy: SKU que existe em OUTRA empresa não é
  -- encontrado quando consultado com company_id=1 (nunca lookup só por
  -- sku_variation).
  -- ═══════════════════════════════════════════════════════════════════════
  IF v_other_company_id IS NOT NULL THEN
    BEGIN
      PERFORM public._update_single_product_by_sku(1, 'TESTE-UPD-CROSS-TENANT', jsonb_build_object('price_override', 1));
      RAISE EXCEPTION 'FALHA (teste 3): SKU de outra empresa não deveria ser encontrado pela empresa 1.';
    EXCEPTION
      WHEN OTHERS THEN
        IF SQLERRM LIKE '%não encontrado%' THEN
          RAISE NOTICE 'OK (teste 3): SKU de outra empresa é invisível — lookup sempre escopado por company_id, nunca vaza cross-tenant.';
        ELSE RAISE; END IF;
    END;
  ELSE
    RAISE NOTICE 'PULADO (teste 3): não há segunda empresa/usuário disponível neste ambiente pra testar isolamento multi-tenant.';
  END IF;

  -- ═══════════════════════════════════════════════════════════════════════
  -- Autorização — usuário sem role reconhecido é rejeitado (mesma política
  -- de rpc_import_products_batch, 20260812).
  -- ═══════════════════════════════════════════════════════════════════════
  BEGIN
    PERFORM public.rpc_update_products_by_sku_batch(
      1, '00000000-0000-0000-0000-000000000000'::uuid,
      jsonb_build_array(jsonb_build_object('client_index', 0, 'sku', 'TESTE-UPD-A-V1', 'price_override', 1)),
      NULL
    );
    RAISE EXCEPTION 'FALHA (autorização): usuário inexistente deveria ter sido rejeitado.';
  EXCEPTION
    WHEN OTHERS THEN
      IF SQLERRM LIKE '%não encontrado%' THEN
        RAISE NOTICE 'OK (autorização): usuário inexistente rejeitado.';
      ELSE RAISE; END IF;
  END;

  -- ═══════════════════════════════════════════════════════════════════════
  -- Idempotência — mesma idempotency_key retorna o resultado cacheado, não
  -- reprocessa (mesmo padrão de rpc_import_products_batch).
  -- ═══════════════════════════════════════════════════════════════════════
  DECLARE
    v_idem_key TEXT := 'teste-update-sku-idem-' || gen_random_uuid()::text;
    v_result_1 JSONB;
    v_result_2 JSONB;
  BEGIN
    v_result_1 := public.rpc_update_products_by_sku_batch(
      1, v_test_user_id,
      jsonb_build_array(jsonb_build_object('client_index', 0, 'sku', 'TESTE-UPD-A-V1', 'price_override', 80.00)),
      v_idem_key
    );
    v_result_2 := public.rpc_update_products_by_sku_batch(
      1, v_test_user_id,
      jsonb_build_array(jsonb_build_object('client_index', 0, 'sku', 'TESTE-UPD-A-V1', 'price_override', 999.00)), -- payload diferente, de propósito
      v_idem_key
    );
    IF v_result_1 IS DISTINCT FROM v_result_2 THEN
      RAISE EXCEPTION 'FALHA (idempotência): segunda chamada com mesma idempotency_key deveria devolver o MESMO resultado cacheado.';
    END IF;
    RAISE NOTICE 'OK (idempotência): mesma idempotency_key devolve resultado cacheado, não reprocessa com o novo payload.';
  END;

  RAISE NOTICE 'rpc_update_products_by_sku_batch.test.sql: todos os testes passaram.';
END $$;

ROLLBACK;
