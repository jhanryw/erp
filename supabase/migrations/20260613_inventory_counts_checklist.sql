-- =============================================================================
-- 20260613_inventory_counts_checklist.sql
--
-- CHECKLIST DE VALIDAÇÃO — rodar no Supabase SQL Editor após aplicar a migration.
--
-- Execute cada bloco em ordem. O resultado esperado está no comentário acima de
-- cada query. NÃO execute nada que altere dados de produção — todas as queries
-- de escrita usam CTEs com RETURNING e fazem ROLLBACK no final.
-- =============================================================================


-- ─────────────────────────────────────────────────────────────────────────────
-- 1. TABELAS CRIADAS
-- ─────────────────────────────────────────────────────────────────────────────
-- Esperado: 2 linhas — 'inventory_counts' e 'inventory_count_items'

SELECT table_name
FROM information_schema.tables
WHERE table_schema = 'public'
  AND table_name IN ('inventory_counts', 'inventory_count_items')
ORDER BY table_name;


-- ─────────────────────────────────────────────────────────────────────────────
-- 2. COLUNAS DE inventory_counts
-- ─────────────────────────────────────────────────────────────────────────────
-- Esperado: id, company_id, stock_location_id, supplier_id, category_id,
--           status, notes, created_by, created_at, finalized_by, finalized_at

SELECT column_name, data_type, is_nullable, column_default
FROM information_schema.columns
WHERE table_schema = 'public' AND table_name = 'inventory_counts'
ORDER BY ordinal_position;


-- ─────────────────────────────────────────────────────────────────────────────
-- 3. COLUNAS DE inventory_count_items
-- ─────────────────────────────────────────────────────────────────────────────
-- Esperado: id, inventory_count_id, product_variation_id,
--           expected_quantity (default 0), counted_quantity (default 0),
--           is_unplanned (default false), last_scanned_at

SELECT column_name, data_type, is_nullable, column_default
FROM information_schema.columns
WHERE table_schema = 'public' AND table_name = 'inventory_count_items'
ORDER BY ordinal_position;


-- ─────────────────────────────────────────────────────────────────────────────
-- 4. ÍNDICES CRIADOS
-- ─────────────────────────────────────────────────────────────────────────────
-- Esperado: 5 índices:
--   idx_ic_company_status
--   uq_ic_one_open_per_location   (partial, WHERE status='open')
--   idx_ici_count_id
--   idx_ici_variation_id
--   + PK automáticos de ambas as tabelas

SELECT indexname, indexdef
FROM pg_indexes
WHERE schemaname = 'public'
  AND tablename IN ('inventory_counts', 'inventory_count_items')
ORDER BY tablename, indexname;


-- ─────────────────────────────────────────────────────────────────────────────
-- 5. CHECK CONSTRAINTS
-- ─────────────────────────────────────────────────────────────────────────────
-- Esperado: chk_ic_status, uq_ici_count_variation,
--           chk_ici_expected_non_neg, chk_ici_counted_non_neg

SELECT conname, contype, pg_get_constraintdef(oid) AS definition
FROM pg_constraint
WHERE conrelid IN (
  'public.inventory_counts'::regclass,
  'public.inventory_count_items'::regclass
)
ORDER BY conrelid::text, conname;


-- ─────────────────────────────────────────────────────────────────────────────
-- 6. SIMULAÇÃO COMPLETA (tudo em uma transação com ROLLBACK)
-- ─────────────────────────────────────────────────────────────────────────────
-- Este bloco simula o fluxo completo sem alterar dados reais.
-- Substitua os valores entre <<  >> pelos reais antes de rodar.
--
--   <<COMPANY_ID>>        → SELECT id FROM companies LIMIT 1
--   <<LOCATION_ID>>       → SELECT id FROM stock_locations WHERE is_main_store = true LIMIT 1
--   <<USER_ID>>           → SELECT id FROM users LIMIT 1
--   <<SKU_VARIATION>>     → SELECT sku_variation FROM product_variations LIMIT 1
--   <<SKU_VARIATION_2>>   → outro sku_variation qualquer

BEGIN;

-- ── 6.1 Substituir placeholders ──────────────────────────────────────────────
-- Ajuste aqui antes de rodar:
DO $$
DECLARE
  v_company_id        int;
  v_location_id       int;
  v_user_id           uuid;
  v_sku_1             text;
  v_sku_2             text;  -- segundo SKU para testar "não previsto no snapshot"
  v_pvid_1            int;
  v_pvid_2            int;
  v_count_id          int;
  v_item_id_1         int;
  v_expected_1        int;
  v_counted_after_scan int;
BEGIN
  -- Lê valores reais do banco
  SELECT id INTO v_company_id   FROM companies  LIMIT 1;
  SELECT id INTO v_location_id  FROM stock_locations WHERE is_main_store = true LIMIT 1;
  SELECT id INTO v_user_id      FROM users       LIMIT 1;

  -- Pega dois SKUs com saldo > 0 no local principal
  SELECT pv.sku_variation, pv.id INTO v_sku_1, v_pvid_1
  FROM product_variations pv
  JOIN stock_balances sb ON sb.product_variation_id = pv.id
    AND sb.stock_location_id = v_location_id
  WHERE sb.quantity > 0
  ORDER BY pv.id
  LIMIT 1;

  SELECT pv.sku_variation, pv.id INTO v_sku_2, v_pvid_2
  FROM product_variations pv
  JOIN stock_balances sb ON sb.product_variation_id = pv.id
    AND sb.stock_location_id = v_location_id
  WHERE sb.quantity > 0
    AND pv.id != v_pvid_1
  ORDER BY pv.id
  LIMIT 1;

  RAISE NOTICE '=== CONFIG ===';
  RAISE NOTICE 'company_id=%   location_id=%   user_id=%', v_company_id, v_location_id, v_user_id;
  RAISE NOTICE 'sku_1=%  pvid_1=%', v_sku_1, v_pvid_1;
  RAISE NOTICE 'sku_2=%  pvid_2=%  (será bipado como "não previsto")', v_sku_2, v_pvid_2;

  -- ── 6.2 Criar sessão ──────────────────────────────────────────────────────
  INSERT INTO inventory_counts (company_id, stock_location_id, status, created_by)
  VALUES (v_company_id, v_location_id, 'open', v_user_id)
  RETURNING id INTO v_count_id;

  RAISE NOTICE '';
  RAISE NOTICE '=== 6.2 SESSÃO CRIADA === count_id=%', v_count_id;


  -- ── 6.3 Snapshot: inserir apenas pvid_1 (pvid_2 ficará "não previsto") ────
  SELECT COALESCE(sb.quantity, 0) INTO v_expected_1
  FROM product_variations pv
  LEFT JOIN stock_balances sb ON sb.product_variation_id = pv.id
    AND sb.stock_location_id = v_location_id
  WHERE pv.id = v_pvid_1;

  INSERT INTO inventory_count_items
    (inventory_count_id, product_variation_id, expected_quantity, counted_quantity, is_unplanned)
  VALUES
    (v_count_id, v_pvid_1, v_expected_1, 0, false)
  RETURNING id INTO v_item_id_1;

  RAISE NOTICE '';
  RAISE NOTICE '=== 6.3 SNAPSHOT ===';
  RAISE NOTICE 'item_id=%  sku=%  expected=%  counted=0  is_unplanned=false',
    v_item_id_1, v_sku_1, v_expected_1;


  -- ── 6.4 Validar snapshot ──────────────────────────────────────────────────
  -- Esperado: 1 linha, expected_quantity > 0, counted_quantity = 0
  RAISE NOTICE '';
  RAISE NOTICE '=== 6.4 ITENS DA SESSÃO APÓS SNAPSHOT ===';
  FOR v_item_id_1 IN
    SELECT ici.id
    FROM inventory_count_items ici
    WHERE ici.inventory_count_id = v_count_id
  LOOP
    NULL; -- só para percorrer; RAISE abaixo mostra resultado
  END LOOP;

  PERFORM 1 FROM inventory_count_items
  WHERE inventory_count_id = v_count_id
    AND expected_quantity = v_expected_1
    AND counted_quantity  = 0
    AND is_unplanned      = false;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'FALHA 6.4: snapshot incorreto';
  END IF;
  RAISE NOTICE 'OK — snapshot correto';


  -- ── 6.5 Bipar sku_1 (está no snapshot) → counted +1 ─────────────────────
  UPDATE inventory_count_items
  SET counted_quantity = counted_quantity + 1,
      last_scanned_at  = NOW()
  WHERE inventory_count_id   = v_count_id
    AND product_variation_id = v_pvid_1;

  SELECT counted_quantity INTO v_counted_after_scan
  FROM inventory_count_items
  WHERE inventory_count_id   = v_count_id
    AND product_variation_id = v_pvid_1;

  RAISE NOTICE '';
  RAISE NOTICE '=== 6.5 BIPAGEM sku_1 ===';
  RAISE NOTICE 'counted_quantity após 1 bip = %  (esperado: 1)', v_counted_after_scan;

  IF v_counted_after_scan <> 1 THEN
    RAISE EXCEPTION 'FALHA 6.5: counted_quantity deveria ser 1, é %', v_counted_after_scan;
  END IF;
  RAISE NOTICE 'OK';


  -- ── 6.6 Bipar sku_1 novamente → counted = 2 ──────────────────────────────
  UPDATE inventory_count_items
  SET counted_quantity = counted_quantity + 1,
      last_scanned_at  = NOW()
  WHERE inventory_count_id   = v_count_id
    AND product_variation_id = v_pvid_1;

  SELECT counted_quantity INTO v_counted_after_scan
  FROM inventory_count_items
  WHERE inventory_count_id   = v_count_id
    AND product_variation_id = v_pvid_1;

  RAISE NOTICE '';
  RAISE NOTICE '=== 6.6 SEGUNDA BIPAGEM sku_1 ===';
  RAISE NOTICE 'counted_quantity após 2 bips = %  (esperado: 2)', v_counted_after_scan;

  IF v_counted_after_scan <> 2 THEN
    RAISE EXCEPTION 'FALHA 6.6: counted_quantity deveria ser 2, é %', v_counted_after_scan;
  END IF;
  RAISE NOTICE 'OK';


  -- ── 6.7 Bipar sku_2 (NÃO estava no snapshot) → inserir como não previsto ─
  INSERT INTO inventory_count_items
    (inventory_count_id, product_variation_id, expected_quantity, counted_quantity, is_unplanned, last_scanned_at)
  VALUES
    (v_count_id, v_pvid_2, 0, 1, true, NOW())
  ON CONFLICT (inventory_count_id, product_variation_id)
  DO UPDATE SET
    counted_quantity = inventory_count_items.counted_quantity + 1,
    last_scanned_at  = NOW();

  RAISE NOTICE '';
  RAISE NOTICE '=== 6.7 BIPAGEM sku_2 (NÃO PREVISTO) ===';

  PERFORM 1 FROM inventory_count_items
  WHERE inventory_count_id   = v_count_id
    AND product_variation_id = v_pvid_2
    AND expected_quantity    = 0
    AND counted_quantity     = 1
    AND is_unplanned         = true;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'FALHA 6.7: item não previsto não foi inserido corretamente';
  END IF;
  RAISE NOTICE 'OK — sku_2 inserido com expected=0, counted=1, is_unplanned=true';


  -- ── 6.8 Verificar divergências antes de finalizar ────────────────────────
  RAISE NOTICE '';
  RAISE NOTICE '=== 6.8 DIVERGÊNCIAS (contagem - esperado) ===';
  RAISE NOTICE 'SKU | esperado | contado | diferença | nao_previsto';

  -- (mostra via SELECT — resultado aparece no output do bloco DO)
  -- Para ver: remova o bloco DO e execute como SELECT direto abaixo

  RAISE NOTICE 'sku_1: esperado=% contado=2 diferença=%',
    v_expected_1, 2 - v_expected_1;
  RAISE NOTICE 'sku_2: esperado=0 contado=1 diferença=+1 (nao_previsto)';


  -- ── 6.9 Simular finalização: status = 'finalized' ────────────────────────
  UPDATE inventory_counts
  SET status       = 'finalized',
      finalized_at = NOW(),
      finalized_by = v_user_id
  WHERE id = v_count_id;

  PERFORM 1 FROM inventory_counts WHERE id = v_count_id AND status = 'finalized';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'FALHA 6.9: status não foi atualizado para finalized';
  END IF;

  RAISE NOTICE '';
  RAISE NOTICE '=== 6.9 FINALIZAÇÃO ===';
  RAISE NOTICE 'OK — status = finalized';


  -- ── 6.10 Bloqueio de sessão dupla ────────────────────────────────────────
  -- Tentar criar segunda sessão OPEN para o mesmo local deve falhar
  BEGIN
    INSERT INTO inventory_counts (company_id, stock_location_id, status, created_by)
    VALUES (v_company_id, v_location_id, 'open', v_user_id);

    -- Se chegou aqui, o índice parcial não está funcionando
    RAISE EXCEPTION 'FALHA 6.10: deveria ter bloqueado sessão dupla';
  EXCEPTION WHEN unique_violation THEN
    RAISE NOTICE '';
    RAISE NOTICE '=== 6.10 BLOQUEIO DE SESSÃO DUPLA ===';
    RAISE NOTICE 'OK — unique_violation lançada como esperado';
  END;

  RAISE NOTICE '';
  RAISE NOTICE '=== TODOS OS CHECKS PASSARAM ===';

END;
$$;

-- IMPORTANTE: rollback ao final — nenhum dado foi alterado em produção
ROLLBACK;


-- ─────────────────────────────────────────────────────────────────────────────
-- 7. VERIFICAR VÍNCULO FORNECEDOR (para filtro de inventário por fornecedor)
-- ─────────────────────────────────────────────────────────────────────────────
-- Esperado: produtos com supplier_id não nulo.
-- Se o resultado for 0, os produtos precisam ter fornecedor preenchido
-- no cadastro antes de usar o filtro de inventário por fornecedor.

SELECT
  COUNT(*)                                           AS total_produtos,
  COUNT(*) FILTER (WHERE supplier_id IS NOT NULL)    AS com_fornecedor,
  COUNT(*) FILTER (WHERE supplier_id IS NULL)        AS sem_fornecedor
FROM products;


-- ─────────────────────────────────────────────────────────────────────────────
-- 8. VERIFICAR SKU_VARIATION COMO CHAVE DE BUSCA (venda por leitor)
-- ─────────────────────────────────────────────────────────────────────────────
-- Esperado: busca exata por sku_variation retorna exatamente 1 linha.
-- Substitua <<SKU>> por um sku_variation real antes de rodar.

SELECT
  pv.id,
  pv.sku_variation,
  p.name                                           AS produto,
  COALESCE(pv.price_override, p.base_price)        AS preco,
  COALESCE(SUM(sb.quantity), 0)                    AS estoque_total
FROM product_variations pv
JOIN products p ON p.id = pv.product_id
LEFT JOIN stock_balances sb ON sb.product_variation_id = pv.id
WHERE pv.sku_variation = '<<SKU>>'   -- substitua por um SKU real
GROUP BY pv.id, pv.sku_variation, p.name, pv.price_override, p.base_price;

-- Esperado: 1 linha com o produto correto e estoque_total > 0.
-- Se retornar 0 linhas: SKU não cadastrado.
-- Se retornar múltiplas linhas: violação de UNIQUE (não deveria ocorrer).


-- ─────────────────────────────────────────────────────────────────────────────
-- 9. SNAPSHOT REAL DE UM LOCAL
-- ─────────────────────────────────────────────────────────────────────────────
-- Mostra o que SERIA o snapshot de um inventário para o Estoque Loja.
-- Substitua <<LOCATION_ID>> pelo ID do local desejado.

SELECT
  pv.id                        AS product_variation_id,
  pv.sku_variation,
  p.name                       AS produto,
  MAX(vv.value) FILTER (WHERE vt.slug = 'cor')     AS cor,
  MAX(vv.value) FILTER (WHERE vt.slug = 'tamanho') AS tamanho,
  COALESCE(sb.quantity, 0)     AS expected_quantity
FROM product_variations pv
JOIN products p ON p.id = pv.product_id AND p.active = true
LEFT JOIN stock_balances sb
  ON sb.product_variation_id = pv.id
  AND sb.stock_location_id = (SELECT id FROM stock_locations WHERE is_main_store = true LIMIT 1)
LEFT JOIN product_variation_attributes pva ON pva.product_variation_id = pv.id
LEFT JOIN variation_types  vt ON vt.id = pva.variation_type_id
LEFT JOIN variation_values vv ON vv.id = pva.variation_value_id
WHERE pv.active = true
GROUP BY pv.id, pv.sku_variation, p.name, sb.quantity
ORDER BY p.name, tamanho, cor
LIMIT 50;

-- Esperado: lista de variações com saldo esperado.
-- Variações com expected_quantity = 0 = sem saldo neste local (mas ativas no sistema).
-- Essas também DEVEM aparecer no snapshot (é válido contar produto zerado).
