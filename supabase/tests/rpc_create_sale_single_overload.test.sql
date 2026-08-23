-- =============================================================================
-- rpc_create_sale_single_overload.test.sql
--
-- Prova o "Blocker 3" da revisão da Fase Fiscal 5C (risco de overload no
-- PostgreSQL): depois de
-- supabase/migrations/20260828_rpc_create_sale_pricing_and_products_total.sql
-- (que faz DROP FUNCTION explícito da assinatura de 16 parâmetros E do
-- wrapper de 12 parâmetros, ANTES de criar a de 17), existe exatamente
-- UMA função `public.rpc_create_sale` — nunca dois overloads conflitantes.
--
-- Cobre:
--   1. Introspecção real de `pg_proc` — exatamente 1 linha para
--      `rpc_create_sale` no schema `public` (a query exata pedida).
--   2. Chamada "estilo antigo" — sem `p_delivery_recipient` — continua
--      funcionando (retrocompatibilidade preservada).
--   3. Chamada "estilo novo" — com `p_delivery_recipient` — funciona e
--      persiste o snapshot.
--   4. GRANTs da assinatura nova: `service_role` tem EXECUTE,
--      `authenticated` e `PUBLIC` não têm (introspecção real via
--      `has_function_privilege`, não suposição).
--
-- COMO RODAR (ambiente de TESTE, DEPOIS de aplicar as migrations desta
-- fase, nunca em produção):
--   psql -v ON_ERROR_STOP=1 "$DATABASE_URL" -f supabase/tests/rpc_create_sale_single_overload.test.sql
--
-- Roda inteiro dentro de BEGIN...ROLLBACK — não é destrutivo (exceto a
-- introspecção de pg_proc/privilégios, que é sempre só leitura).
-- =============================================================================

-- ─── Bloco 1 — introspecção real: exatamente 1 função ──────────────────────
-- Fora de transação/ROLLBACK de propósito — é só leitura de catálogo, e
-- você provavelmente quer ver este resultado mesmo se o resto do arquivo
-- falhar por falta de pré-requisito de ambiente (empresa 1 sem Estoque Loja
-- configurado, por exemplo).
SELECT
  p.oid::regprocedure,
  pg_get_function_arguments(p.oid) AS argumentos
FROM pg_proc p
JOIN pg_namespace n ON n.oid = p.pronamespace
WHERE n.nspname = 'public'
  AND p.proname = 'rpc_create_sale';
-- Esperado: EXATAMENTE 1 linha, com 17 argumentos, o último sendo
-- "p_delivery_recipient jsonb DEFAULT NULL::jsonb". Se aparecer mais de
-- 1 linha, a migration NÃO removeu todas as assinaturas antigas — pare e
-- não confie em nenhum resultado abaixo até corrigir isso.

DO $$
DECLARE
  v_count int;
BEGIN
  SELECT COUNT(*) INTO v_count
  FROM pg_proc p
  JOIN pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname = 'public' AND p.proname = 'rpc_create_sale';

  IF v_count <> 1 THEN
    RAISE EXCEPTION 'FALHA CRÍTICA: esperava exatamente 1 função public.rpc_create_sale, encontrei %. Overload não resolvido — não aplique nada em produção com esse resultado.', v_count;
  END IF;

  RAISE NOTICE 'OK — exatamente 1 função public.rpc_create_sale existe (nenhum overload).';
END $$;

-- ─── Bloco 2 — GRANTs da assinatura nova ────────────────────────────────────
-- Checa os 4 papéis relevantes explicitamente — NUNCA presumir que
-- revogar só PUBLIC fecha a exposição. Evidência real trazida pelo
-- usuário nesta revisão: as duas assinaturas antigas de rpc_create_sale
-- tinham grant EXPLÍCITO (não só herdado de PUBLIC) para anon E
-- authenticated — típico de projetos Supabase, que configuram privilégios
-- default de projeto para esses papéis fora da árvore de migrations. Por
-- isso `anon` é checado aqui com o mesmo peso que `authenticated`/PUBLIC,
-- não como uma checagem redundante.
DO $$
DECLARE
  v_service_role_has boolean;
  v_authenticated_has boolean;
  v_anon_has boolean;
  v_public_has boolean;
  v_sig text := 'public.rpc_create_sale(int, uuid, payment_method, text, numeric, numeric, numeric, text, jsonb, uuid, numeric, numeric, jsonb, bigint, text, int, jsonb)';
BEGIN
  v_service_role_has  := has_function_privilege('service_role', v_sig, 'EXECUTE');
  v_authenticated_has := has_function_privilege('authenticated', v_sig, 'EXECUTE');
  v_anon_has          := has_function_privilege('anon', v_sig, 'EXECUTE');
  v_public_has        := has_function_privilege('public', v_sig, 'EXECUTE');

  IF NOT v_service_role_has THEN
    RAISE EXCEPTION 'FALHA: service_role deveria ter EXECUTE em rpc_create_sale, não tem.';
  END IF;
  IF v_authenticated_has THEN
    RAISE EXCEPTION 'FALHA CRÍTICA DE SEGURANÇA: authenticated tem EXECUTE em rpc_create_sale — deveria ter sido revogado (Blocker 3).';
  END IF;
  IF v_anon_has THEN
    RAISE EXCEPTION 'FALHA CRÍTICA DE SEGURANÇA: anon tem EXECUTE em rpc_create_sale — qualquer requisição sem sessão poderia criar vendas. Deveria ter sido revogado (Blocker 3).';
  END IF;
  IF v_public_has THEN
    RAISE EXCEPTION 'FALHA CRÍTICA DE SEGURANÇA: PUBLIC tem EXECUTE em rpc_create_sale — privilégio default (Postgres e/ou projeto Supabase) não foi revogado (Blocker 3).';
  END IF;

  RAISE NOTICE 'OK — GRANTs corretos: service_role SIM, authenticated/anon/PUBLIC NÃO.';
END $$;

-- ─── Blocos 3-4 — chamadas real: estilo antigo (sem recipient) e novo (com) ──
BEGIN;

DO $$
DECLARE
  v_main_store_id int;
  v_user           uuid;
  v_category_id    int;
  v_product_id     int;
  v_variation      int;
  v_sale_result    jsonb;
  v_sale_id_old    int;
  v_sale_id_new    int;
BEGIN
  v_main_store_id := public.fn_main_store_id(1);
  IF v_main_store_id IS NULL THEN
    RAISE NOTICE 'PULADO (Blocos 3-4): empresa 1 sem Estoque Loja configurado — pré-requisito de ambiente.';
    RETURN;
  END IF;

  SELECT id INTO v_user FROM public.users WHERE company_id = 1 AND active = true LIMIT 1;
  IF v_user IS NULL THEN
    RAISE NOTICE 'PULADO (Blocos 3-4): nenhum usuário ativo na empresa 1.';
    RETURN;
  END IF;

  INSERT INTO public.categories (name, slug, company_id, active)
  VALUES ('TESTE Single Overload — APAGAR', 'teste-single-overload-apagar', 1, true)
  ON CONFLICT DO NOTHING;
  SELECT id INTO v_category_id FROM public.categories WHERE slug = 'teste-single-overload-apagar';

  INSERT INTO public.products (name, sku, category_id, company_id, tipo, modelo, ano, base_cost, base_price, active)
  VALUES ('Produto Teste Single Overload', 'TESTE-SO-0001', v_category_id, 1, 'x', 'y', '2026', 10, 30, true)
  RETURNING id INTO v_product_id;

  INSERT INTO public.product_variations (product_id, sku_variation, active)
  VALUES (v_product_id, 'TESTE-SO-0001-V1', true)
  RETURNING id INTO v_variation;

  INSERT INTO public.stock_balances (product_variation_id, stock_location_id, quantity, last_updated)
  VALUES (v_variation, v_main_store_id, 10, NOW())
  ON CONFLICT (product_variation_id, stock_location_id) DO UPDATE SET quantity = 10;

  -- Bloco 3 — chamada "estilo antigo": nomeada, SEM p_delivery_recipient,
  -- exatamente como o webhook da Nuvemshop chama hoje
  -- (src/app/api/webhooks/nuvemshop/order/route.ts:526-540). Antes da
  -- correção do Blocker 3, esta chamada seria ambígua entre os dois
  -- overloads; depois, resolve sem ambiguidade porque só existe 1 função.
  v_sale_result := public.rpc_create_sale(
    p_customer_id      => NULL,
    p_seller_id        => v_user,
    p_payment_method   => 'pix',
    p_sale_origin      => 'website',
    p_discount_amount  => 0,
    p_surcharge_amount => 0,
    p_cashback_used    => 0,
    p_shipping_charged => 0,
    p_notes            => 'teste single-overload — estilo antigo (sem recipient) — apagar',
    p_items            => jsonb_build_array(jsonb_build_object('product_variation_id', v_variation, 'quantity', 1, 'unit_price', 30, 'unit_cost', 10, 'discount_amount', 0)),
    p_system_user_id   => v_user,
    p_payments         => NULL,
    p_stock_mode       => 'online_priority'
  );
  v_sale_id_old := (v_sale_result->>'id')::int;

  IF v_sale_id_old IS NULL THEN
    RAISE EXCEPTION 'FALHA Bloco 3: chamada estilo antigo (sem p_delivery_recipient) não criou a venda.';
  END IF;
  IF EXISTS (SELECT 1 FROM public.sale_recipients WHERE sale_id = v_sale_id_old) THEN
    RAISE EXCEPTION 'FALHA Bloco 3: chamada sem p_delivery_recipient não deveria ter criado snapshot.';
  END IF;

  RAISE NOTICE 'OK — Bloco 3 (chamada estilo antigo, sem p_delivery_recipient, resolve sem ambiguidade)';

  -- Bloco 4 — chamada "estilo novo": COM p_delivery_recipient
  v_sale_result := public.rpc_create_sale(
    p_customer_id        => NULL,
    p_seller_id          => v_user,
    p_payment_method     => 'pix',
    p_sale_origin        => 'store',
    p_discount_amount    => 0,
    p_surcharge_amount   => 0,
    p_cashback_used      => 0,
    p_shipping_charged   => 0,
    p_notes              => 'teste single-overload — estilo novo (com recipient) — apagar',
    p_items              => jsonb_build_array(jsonb_build_object('product_variation_id', v_variation, 'quantity', 1, 'unit_price', 30, 'unit_cost', 10, 'discount_amount', 0)),
    p_system_user_id     => v_user,
    p_delivery_recipient => jsonb_build_object(
      'nome', 'Teste Single Overload', 'cep', '59000000', 'logradouro', 'Rua Teste',
      'numero', '1', 'bairro', 'Centro', 'municipio', 'Natal', 'uf', 'RN', 'municipio_ibge', '2408102'
    )
  );
  v_sale_id_new := (v_sale_result->>'id')::int;

  IF NOT EXISTS (SELECT 1 FROM public.sale_recipients WHERE sale_id = v_sale_id_new) THEN
    RAISE EXCEPTION 'FALHA Bloco 4: chamada com p_delivery_recipient deveria ter criado o snapshot.';
  END IF;

  RAISE NOTICE 'OK — Bloco 4 (chamada estilo novo, com p_delivery_recipient, resolve pra mesma função e persiste o snapshot)';
END $$;

ROLLBACK;
-- =============================================================================
-- FIM — Blocos 3-4 não persistem nada (ROLLBACK). Blocos 1-2 são só leitura.
-- =============================================================================
