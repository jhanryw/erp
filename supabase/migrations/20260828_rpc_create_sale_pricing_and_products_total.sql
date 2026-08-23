-- Fase Fiscal 5C — fundação de endereço/snapshot (parte 4/4).
--
-- REVISÃO desta migration (mesma fase, antes de qualquer aplicação em
-- banco real — nada desta migration foi aplicado ainda) — corrige 2
-- blockers arquiteturais encontrados na revisão:
--
-- BLOCKER 1 — atomicidade sale+destinatário. Antes: `sale_recipients` era
-- gravado numa segunda chamada, depois de `rpc_create_sale` já ter
-- commitado — mesmo padrão não-atômico já usado (e já questionável) para
-- `shipments`. Uma venda de entrega podia ficar com a venda criada e o
-- snapshot fiscal do destinatário ausente, se a segunda chamada falhasse.
-- Correção: `rpc_create_sale` ganha um parâmetro novo, opcional,
-- `p_delivery_recipient jsonb DEFAULT NULL` — quando presente, o snapshot
-- (e, se pedido, o cadastro reutilizável em `customer_addresses`) é
-- gravado DENTRO da mesma transação da venda. Qualquer falha nessa escrita
--(inclusive violação de CHECK/NOT NULL do schema novo) propaga a exceção
-- e desfaz TUDO — venda, itens, estoque, financeiro, evento de domínio —
-- via ROLLBACK automático da transação (comportamento padrão do Postgres
-- para uma função que levanta exceção sem capturá-la). Retirada continua
-- sem exigir nada disso — `p_delivery_recipient=NULL` é o comportamento
-- de sempre.
--
-- Achado adicional durante esta auditoria, corrigido junto por estar
-- diretamente implicado pelo requisito de "isolamento por company_id, não
-- confiar em company_id vindo do frontend": nem esta função nem a camada
-- de serviço (`vendas.service.ts`) validavam que `p_customer_id` pertence
-- a `v_company_id` (a empresa do usuário autenticado, resolvida
-- server-side a partir de `p_system_user_id` — nunca de um parâmetro
-- vindo do cliente). Isso já era uma lacuna antes desta fase, mas fica
-- diretamente relevante agora porque o snapshot de entrega pode ler um
-- `customer_address_id` — sem essa checagem, um usuário de uma empresa
-- poderia, em tese, encadear `customer_id` de outra empresa com o próprio
-- `company_id` da sessão. Adicionada checagem `EXISTS(...customers WHERE
-- id=p_customer_id AND company_id=v_company_id)`, mesma forma/estilo já
-- usada para `p_responsible_seller_id` logo abaixo.
--
-- BLOCKER 2 — fórmula de `products_total`. Corrigida para incluir
-- `sales.surcharge_amount` (acréscimo GLOBAL de mercadoria), simétrico ao
-- já existente `sales.discount_amount`:
--
--   products_total = subtotal − sales.discount_amount + sales.surcharge_amount
--
-- Nunca inclui `shipping_charged`. `subtotal` já soma `total_price` de
-- cada item (que já inclui qualquer ajuste POR ITEM — preço negociado
-- embutido em `unit_price`, mais `discount_amount`/`surcharge_amount`
-- explícitos do item) — `sales.discount_amount`/`sales.surcharge_amount`
-- são campos de nível de PEDIDO, independentes dos itens por construção
-- (nunca derivados somando-os), então somá-los aqui nunca duplica um
-- ajuste já contado no subtotal. Fórmula idêntica (mesmos nomes de
-- variável/parâmetro) espelhada em `src/lib/sales/pricing.ts`
-- (`computeProductsTotal`) — ver `docs/fiscal-fase5c-blockers-revisao.md`
-- para a demonstração completa e os testes espelhados (TS + SQL) que
-- prova as duas fórmulas produzem os mesmos números para os mesmos
-- cenários.
--
-- Nenhuma outra parte da função é tocada (estoque, cashback, pagamentos,
-- numeração, evento de domínio continuam exatamente como estão na versão
-- vigente, 20260817_sale_rpcs_emit_outbox_events.sql). SECURITY DEFINER e
-- `SET search_path = public` permanecem idênticos (auditados nesta
-- revisão, não alterados — a função continua sem aceitar nenhum SQL
-- dinâmico/EXECUTE, só JSON via operadores `->>`/`->`, o mesmo padrão já
-- seguro usado para `p_items`/`p_payments`).
--
-- BLOCKER 3 (achado na revisão seguinte, ANTES desta migration ter sido
-- aplicada — corrigido aqui, nunca chegou a existir em produção) — risco
-- real de overload/ambiguidade. A afirmação anterior deste arquivo
-- ("Nenhuma mudança de GRANT — CREATE OR REPLACE preserva permissões
-- existentes") estava ERRADA para este caso específico e foi removida.
--
-- Fato de Postgres, não opinião: a IDENTIDADE de uma função para fins de
-- `CREATE OR REPLACE` é (schema, nome, LISTA ORDENADA DE TIPOS dos
-- parâmetros de entrada) — nomes de parâmetro, DEFAULTs e tipo de retorno
-- não entram nessa chave. A assinatura vigente de `rpc_create_sale` (ver
-- REVOKE/GRANT de 20260811_fix_rpc_identity_grants_tenant.sql:600-607,
-- fonte primária, não presumida) é:
--
--   rpc_create_sale(int, uuid, payment_method, text, numeric, numeric,
--                    numeric, text, jsonb, uuid, numeric, numeric, jsonb,
--                    bigint, text, int)                    -- 16 tipos
--
-- Adicionar um 17º parâmetro (`p_delivery_recipient jsonb`) muda essa
-- lista de tipos — logo, um simples `CREATE OR REPLACE FUNCTION` com a
-- assinatura de 17 parâmetros NÃO substitui a de 16: cria uma SEGUNDA
-- função (overload) coexistindo com a primeira. Isso já aconteceu de
-- verdade neste projeto antes (ver
-- src/lib/db/migrations/archive/034_fix_rpc_sale_stock_sync.sql:5,
-- "Existem 3 versões sobrecarregadas de rpc_create_sale no banco" — o
-- próprio time já teve que limpar esse tipo de acúmulo uma vez).
--
-- Consequência concreta, não hipotética: qualquer chamada que NÃO inclua
-- `p_delivery_recipient` (nomeado ou posicional) passaria a ser ambígua
-- entre as duas funções (mesmos 16 tipos compartilhados) — o resultado
-- exato depende do algoritmo de resolução de overload do Postgres para
-- argumentos com DEFAULT (prefere o candidato que precisa preencher MENOS
-- defaults; em caso de empate, erro "function is not unique"). Isso
-- afetaria de verdade o webhook da Nuvemshop
-- (`src/app/api/webhooks/nuvemshop/order/route.ts:526-540`, chamada
-- nomeada SEM `p_delivery_recipient`) e qualquer teste SQL que chame
-- `rpc_create_sale` posicionalmente com menos de 17 argumentos (vários
-- existem em `supabase/tests/*.test.sql`) — na melhor hipótese, erro
-- "function is not unique"; na pior, resolução silenciosa para a função
-- errada. Nenhum dos dois é aceitável.
--
-- Além disso, uma função nova (não um replace de verdade) recebe pelo
-- menos EXECUTE liberado para PUBLIC por padrão no Postgres (privilégio
-- default documentado só para functions/procedures, diferente de
-- tabelas). CONFIRMADO com dado real do banco (trazido pelo usuário nesta
-- revisão, não presumido): as DUAS assinaturas hoje vivas de
-- rpc_create_sale (a de 16 parâmetros E o wrapper de 12) têm grant
-- EXECUTE EXPLÍCITO — não só herdado de PUBLIC — para PUBLIC, anon,
-- authenticated, service_role, postgres, supabase_admin. Isso é maior que
-- o risco só de PUBLIC-por-default: é consistente com o comportamento
-- conhecido de projetos Supabase, que configuram `ALTER DEFAULT
-- PRIVILEGES` a nível de projeto (fora da árvore de migrations de
-- usuário, não encontrável por grep em supabase/migrations/*.sql)
-- concedendo privilégios default a `anon`/`authenticated`/`service_role`
-- em novos objetos do schema `public`. Por isso vários outros arquivos
-- deste projeto já fazem `REVOKE ALL ... FROM PUBLIC, anon, authenticated`
-- explicitamente pra qualquer RPC sensível (20260627_authorization_
-- tokens_v2.sql:23, 20260816_fix_stock_media_repasse_rpc_grants_public.
-- sql, 202607302600_pim_product_sku_identity.sql) — mesmo padrão adotado
-- aqui, agora nos 3 papéis explicitamente (nunca assumir que revogar só
-- PUBLIC fecha a exposição — `anon`/`authenticated` têm grant DIRETO e
-- independente, que uma revogação de PUBLIC não remove).
--
-- CORREÇÃO: `DROP FUNCTION` explícito da assinatura de 16 parâmetros
-- ANTES do `CREATE OR REPLACE FUNCTION` da de 17 — garante que só existe
-- UMA função `rpc_create_sale` depois desta migration, elimina qualquer
-- ambiguidade por construção (não por sorte de resolução de overload), e
-- os GRANT/REVOKE (PUBLIC/anon/authenticated fora, service_role dentro)
-- são reaplicados explicitamente logo depois do CREATE — necessário
-- agora, já que depois do DROP não há nada "preservado" para essa
-- assinatura (ver Passo 3 abaixo).
--
-- Achado adicional, também corrigido aqui por estar diretamente no mesmo
-- lugar: existe uma SEGUNDA função `rpc_create_sale` já coexistindo desde
-- 20260610_multi_estoque.sql — um "wrapper de compatibilidade" de 12
-- parâmetros (assinatura: boolean, numeric, int, numeric, jsonb, text,
-- text, text, uuid, numeric, numeric, uuid — primeiro tipo `boolean`,
-- nunca colide com a assinatura principal). Nenhuma migration posterior
-- jamais a removeu (grep exaustivo em supabase/migrations/*.sql — as 4
-- `DROP FUNCTION rpc_create_sale(...)` existentes visam só as reescritas
-- sucessivas da função PRINCIPAL, nunca este wrapper) — e, pela evidência
-- real trazida pelo usuário, ela TAMBÉM está com grant explícito para
-- PUBLIC/anon/authenticated hoje. `DROP FUNCTION IF EXISTS` dela incluído
-- abaixo — não é chamada por nenhum código vivo (grep em src/ confirma) e
-- removê-la elimina de vez essa superfície, sem precisar de um REVOKE
-- separado (a função deixa de existir).
--
-- Achado crítico ADICIONAL, PRÉ-EXISTENTE (não introduzido por esta fase,
-- e não corrigido aqui por estar fora do escopo desta migration — sobre
-- OUTRAS funções, não rpc_create_sale): a mesma lacuna (REVOKE de
-- 20260811_fix_rpc_identity_grants_tenant.sql:600-641 revogando só de
-- `authenticated`, nunca de `PUBLIC`/`anon`) se repete para as outras 10
-- RPCs tocadas por aquela migration: rpc_cancel_sale, rpc_return_sale,
-- rpc_process_exchange, rpc_open_cash_session, rpc_add_cash_movement,
-- rpc_close_cash_session, rpc_cancel_cash_movement, rpc_reopen_cash_
-- session, rpc_stock_entry, rpc_stock_adjust, rpc_pagar_repasse_lote —
-- dado o padrão real confirmado agora em rpc_create_sale (grant explícito
-- pra PUBLIC/anon, não só herança), é razoável esperar que essas 10 RPCs
-- tenham o mesmo problema. NÃO CONFIRMADO ao vivo para elas
-- especificamente nesta revisão (só rpc_create_sale foi checada contra o
-- banco real). Recomendo forte: rodar a mesma introspecção
-- (`information_schema.routine_privileges` ou `has_function_privilege`)
-- pra essas 10 funções e tratar a correção delas como uma migration
-- separada — fora do escopo deste blocker específico, mas com prioridade
-- alta dado o achado confirmado aqui.

-- ═══════════════════════════════════════════════════════════════════════════════
-- Passo 1 — DROP explícito de toda assinatura antiga de rpc_create_sale,
-- ANTES do CREATE novo. Garante exatamente 1 função ao final desta
-- migration (ver smoke test em
-- supabase/tests/rpc_create_sale_single_overload.test.sql).
-- ═══════════════════════════════════════════════════════════════════════════════

DROP FUNCTION IF EXISTS public.rpc_create_sale(
  int, uuid, payment_method, text, numeric, numeric, numeric, text,
  jsonb, uuid, numeric, numeric, jsonb, bigint, text, int
);

-- Wrapper de compatibilidade de 12 parâmetros (20260610_multi_estoque.sql)
-- — nunca removido por nenhuma migration anterior, sem uso em código vivo
-- (grep em src/ confirma). Removido aqui por higiene, junto do blocker de
-- overload que motivou esta auditoria.
DROP FUNCTION IF EXISTS public.rpc_create_sale(
  boolean, numeric, int, numeric, jsonb, text, text, text, uuid, numeric, numeric, uuid
);

-- ═══════════════════════════════════════════════════════════════════════════════
-- Passo 2 — cria a função com a assinatura nova (17 parâmetros). Como o
-- Passo 1 já removeu qualquer função existente com esse nome, isto é
-- equivalente a um CREATE FUNCTION do zero (CREATE OR REPLACE mantido só
-- por idiomatismo/consistência com o resto do arquivo).
-- ═══════════════════════════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION public.rpc_create_sale(
  p_customer_id           int,
  p_seller_id             uuid,
  p_payment_method        payment_method,
  p_sale_origin           text,
  p_discount_amount       numeric,
  p_cashback_used         numeric,
  p_shipping_charged      numeric,
  p_notes                 text,
  p_items                 jsonb,
  p_system_user_id        uuid,
  p_card_fee              numeric  DEFAULT 0,
  p_surcharge_amount      numeric  DEFAULT 0,
  p_payments              jsonb    DEFAULT NULL,
  p_cash_session_id       bigint   DEFAULT NULL,
  p_stock_mode            text     DEFAULT 'main_store',
  p_responsible_seller_id int      DEFAULT NULL,
  -- Fase Fiscal 5C (revisão — Blocker 1). JSON com o snapshot de
  -- destinatário/endereço de entrega. Chaves aceitas: nome, cpf, cnpj,
  -- telefone, cep, logradouro, numero, complemento, bairro, municipio, uf,
  -- municipio_ibge, ibge_source, customer_address_id, save_as_customer_address.
  -- NUNCA aceita company_id (sempre v_company_id, resolvido server-side).
  p_delivery_recipient    jsonb    DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_sale_id         int;
  v_sale_number     text;
  v_subtotal        numeric := 0;
  v_products_total  numeric;
  v_gross           numeric;
  v_total           numeric;
  v_eff_cashback    numeric;
  v_avail_credit    numeric;
  v_item            jsonb;
  v_pvid            int;
  v_qty             int;
  v_unit_price      numeric;
  v_unit_cost       numeric;
  v_discount        numeric;
  v_item_surcharge  numeric;
  v_list_price      numeric;
  v_current_qty     int;
  v_item_total      numeric;
  v_company_id      int;
  v_item_company    int;
  v_card_fee        numeric;
  v_surcharge       numeric;
  v_brazil_date     date;
  v_main_store_id   int;

  v_pmt             jsonb;
  v_pmt_method      payment_method;
  v_pmt_tendered    numeric;
  v_pmt_change      numeric;
  v_pmt_change_mth  text;
  v_pmt_net         numeric;
  v_pmt_install     int;
  v_pmt_brand       text;
  v_pmt_acquirer    text;
  v_pmt_fee         numeric;
  v_dominant_method payment_method;
  v_max_net         numeric := -1;

  v_online_loc      record;
  v_loc_qty         int;
  v_debit           int;
  v_remaining       int;

  -- Cashback earn (restaurado de 20260612, ausente em v4)
  v_is_anon         boolean;
  v_rate_pct        numeric;
  v_release_days    int;
  v_expiry_days     int;
  v_min_order       numeric;
  v_earn_amount     numeric;
  v_earn_status     cashback_status;
  v_earn_release    date;
  v_earn_expiry     date;

  -- Fase Fiscal 5C (revisão — Blocker 1) — snapshot de destinatário
  v_recip_source_addr_id int;
  v_recip_addr           record;
  v_recip_cep             text;
  v_recip_logradouro      text;
  v_recip_numero          text;
  v_recip_complemento     text;
  v_recip_bairro          text;
  v_recip_municipio       text;
  v_recip_uf              text;
  v_recip_municipio_ibge  text;
  v_recip_ibge_source     text;
BEGIN
  PERFORM set_config('app.stock_rpc', '1', true);

  IF p_stock_mode NOT IN ('main_store', 'online_priority') THEN
    RAISE EXCEPTION 'p_stock_mode inválido: %. Aceitos: main_store, online_priority.', p_stock_mode
      USING ERRCODE = 'P0001';
  END IF;

  SELECT company_id INTO v_company_id FROM users WHERE id = p_system_user_id;

  IF v_company_id IS NULL THEN
    RAISE EXCEPTION 'Usuário não associado a empresa.' USING ERRCODE = 'P0001';
  END IF;

  -- Fase Fiscal 5C (revisão) — isolamento por company_id: p_customer_id
  -- precisa pertencer à MESMA empresa do usuário autenticado. Nunca
  -- confiar em company_id vindo do payload — v_company_id já foi resolvido
  -- acima, exclusivamente a partir de p_system_user_id (sessão real).
  IF p_customer_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM customers WHERE id = p_customer_id AND company_id = v_company_id
  ) THEN
    RAISE EXCEPTION 'Cliente não pertence à empresa.' USING ERRCODE = 'P0001';
  END IF;

  IF p_responsible_seller_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM sellers
    WHERE id = p_responsible_seller_id
      AND company_id = v_company_id
      AND active = TRUE
  ) THEN
    RAISE EXCEPTION 'Vendedor responsável inválido ou inativo.' USING ERRCODE = 'P0001';
  END IF;

  v_brazil_date := (NOW() AT TIME ZONE 'America/Sao_Paulo')::date;

  IF p_stock_mode = 'main_store' THEN
    v_main_store_id := public.fn_main_store_id(v_company_id);
    IF v_main_store_id IS NULL THEN
      RAISE EXCEPTION 'Estoque Loja não configurado para esta empresa (company_id=%).',
        v_company_id USING ERRCODE = 'P0001';
    END IF;
  END IF;

  IF p_items IS NULL OR jsonb_array_length(p_items) = 0 THEN
    RAISE EXCEPTION 'Nenhum item na venda.' USING ERRCODE = 'P0001';
  END IF;

  FOR v_item IN SELECT value FROM jsonb_array_elements(p_items) LOOP
    v_pvid           := (v_item->>'product_variation_id')::int;
    v_qty            := (v_item->>'quantity')::int;
    v_unit_price     := (v_item->>'unit_price')::numeric;
    v_discount       := COALESCE((v_item->>'discount_amount')::numeric, 0);
    v_item_surcharge := COALESCE((v_item->>'surcharge_amount')::numeric, 0);

    SELECT p.company_id INTO v_item_company
    FROM product_variations pv JOIN products p ON p.id = pv.product_id
    WHERE pv.id = v_pvid;

    IF v_item_company IS DISTINCT FROM v_company_id THEN
      RAISE EXCEPTION 'Produto não pertence à empresa.' USING ERRCODE = 'P0001';
    END IF;

    v_subtotal := v_subtotal + ROUND(v_unit_price * v_qty - v_discount + v_item_surcharge, 2);
  END LOOP;

  v_card_fee       := COALESCE(p_card_fee, 0);
  v_surcharge      := COALESCE(p_surcharge_amount, 0);
  -- BLOCKER 2 — fórmula definitiva (ver comentário de topo do arquivo):
  -- inclui o acréscimo GLOBAL de mercadoria (v_surcharge), nunca o frete.
  v_products_total := ROUND(v_subtotal - COALESCE(p_discount_amount, 0) + v_surcharge, 2);
  v_eff_cashback   := LEAST(COALESCE(p_cashback_used, 0), v_subtotal - COALESCE(p_discount_amount, 0));
  v_gross          := ROUND(v_subtotal - COALESCE(p_discount_amount, 0) + v_surcharge + COALESCE(p_shipping_charged, 0), 2);
  v_total          := ROUND(v_gross - v_eff_cashback, 2);

  -- ─── Validar saldo de crédito ─────────────────────────────────────────────
  -- CORREÇÃO v5: filtra expiry_date E company_id.
  -- Cashback vencido ou de outra empresa não conta, mesmo sem o job rodar.
  IF v_eff_cashback > 0 THEN
    IF p_customer_id IS NULL THEN
      RAISE EXCEPTION 'Não é possível usar crédito em venda sem cliente identificado.'
        USING ERRCODE = 'P0001';
    END IF;

    SELECT GREATEST(0,
      COALESCE(SUM(CASE
                     WHEN type = 'earn'
                      AND status = 'available'
                      AND amount > 0
                      AND (expiry_date IS NULL OR expiry_date > CURRENT_DATE)
                     THEN amount ELSE 0 END), 0) -
      COALESCE(SUM(CASE WHEN type = 'use' THEN amount ELSE 0 END), 0)
    ) INTO v_avail_credit
    FROM cashback_transactions
    WHERE customer_id = p_customer_id
      AND company_id  = v_company_id;

    IF v_avail_credit < v_eff_cashback THEN
      RAISE EXCEPTION
        'Saldo de crédito insuficiente. Disponível: R$ %, solicitado: R$ %.',
        v_avail_credit, v_eff_cashback
        USING ERRCODE = 'P0001';
    END IF;
  END IF;

  IF p_payments IS NOT NULL AND jsonb_array_length(p_payments) > 0 THEN
    FOR v_pmt IN SELECT value FROM jsonb_array_elements(p_payments) LOOP
      v_pmt_net := COALESCE((v_pmt->>'net_amount')::numeric, 0);
      IF v_pmt_net > v_max_net THEN
        v_max_net         := v_pmt_net;
        v_dominant_method := (v_pmt->>'method')::payment_method;
      END IF;
    END LOOP;
  END IF;

  IF p_stock_mode = 'main_store' THEN
    FOR v_pvid IN
      SELECT DISTINCT (value->>'product_variation_id')::int AS pvid
      FROM jsonb_array_elements(p_items) ORDER BY pvid
    LOOP
      PERFORM 1
      FROM stock_balances
      WHERE product_variation_id = v_pvid
        AND stock_location_id    = v_main_store_id
      FOR UPDATE;
    END LOOP;
  ELSE
    PERFORM 1
    FROM stock_balances sb
    JOIN stock_locations sl ON sl.id = sb.stock_location_id
    WHERE sb.product_variation_id IN (
      SELECT DISTINCT (value->>'product_variation_id')::int
      FROM jsonb_array_elements(p_items)
    )
      AND sl.company_id = v_company_id
      AND sl.active     = true
    ORDER BY sb.product_variation_id ASC, sb.stock_location_id ASC
    FOR UPDATE OF sb;
  END IF;

  INSERT INTO sales (
    customer_id, seller_id, status,
    subtotal, discount_amount, surcharge_amount, cashback_used, shipping_charged, total,
    products_total,
    payment_method, sale_origin, notes, sale_date, company_id, cash_session_id,
    responsible_seller_id
  )
  VALUES (
    p_customer_id, p_seller_id, 'paid',
    ROUND(v_subtotal, 2), p_discount_amount, v_surcharge, p_cashback_used,
    p_shipping_charged, ROUND(v_total, 2),
    v_products_total,
    COALESCE(v_dominant_method, p_payment_method),
    NULLIF(p_sale_origin, '')::customer_origin,
    p_notes, v_brazil_date, v_company_id, p_cash_session_id,
    p_responsible_seller_id
  )
  RETURNING id, sale_number INTO v_sale_id, v_sale_number;

  -- ─── Registrar consumo de crédito ────────────────────────────────────────
  IF v_eff_cashback > 0 AND p_customer_id IS NOT NULL THEN
    INSERT INTO cashback_transactions (
      customer_id, company_id, sale_id,
      type, amount, status,
      used_at, used_in_sale_id
    )
    VALUES (
      p_customer_id, v_company_id, v_sale_id,
      'use', v_eff_cashback, 'used',
      NOW(), v_sale_id
    );
  END IF;

  FOR v_item IN SELECT value FROM jsonb_array_elements(p_items) LOOP
    v_pvid           := (v_item->>'product_variation_id')::int;
    v_qty            := (v_item->>'quantity')::int;
    v_unit_price     := (v_item->>'unit_price')::numeric;
    v_unit_cost      := (v_item->>'unit_cost')::numeric;
    v_discount       := COALESCE((v_item->>'discount_amount')::numeric, 0);
    v_item_surcharge := COALESCE((v_item->>'surcharge_amount')::numeric, 0);
    v_list_price     := NULLIF(v_item->>'list_price_snapshot', '')::numeric;
    v_item_total     := ROUND(v_unit_price * v_qty - v_discount + v_item_surcharge, 2);

    INSERT INTO sale_items (
      sale_id, product_variation_id, quantity,
      unit_price, unit_cost, discount_amount, surcharge_amount, list_price_snapshot, total_price
    )
    VALUES (v_sale_id, v_pvid, v_qty, v_unit_price, v_unit_cost, v_discount, v_item_surcharge, v_list_price, v_item_total);

    IF p_stock_mode = 'main_store' THEN

      SELECT COALESCE(quantity, 0) INTO v_current_qty
      FROM stock_balances
      WHERE product_variation_id = v_pvid
        AND stock_location_id    = v_main_store_id;

      IF COALESCE(v_current_qty, 0) < v_qty THEN
        RAISE EXCEPTION
          'Produto sem saldo no Estoque Loja (variação #%). '
          'Disponível: %, solicitado: %. Transfira antes de vender.',
          v_pvid, COALESCE(v_current_qty, 0), v_qty
          USING ERRCODE = 'P0001';
      END IF;

      UPDATE stock_balances
      SET quantity     = quantity - v_qty,
          last_updated = NOW()
      WHERE product_variation_id = v_pvid
        AND stock_location_id    = v_main_store_id;

      INSERT INTO stock_movements (
        product_variation_id, product_id, type, quantity,
        previous_stock, new_stock, unit_cost, reference_id, company_id,
        source_location_id, movement_type, reference_type, created_by
      )
      SELECT
        v_pvid, pv.product_id,
        'sale', -v_qty,
        v_current_qty, v_current_qty - v_qty,
        v_unit_cost, v_sale_id::text, v_company_id,
        v_main_store_id, 'sale', 'sale', p_system_user_id
      FROM product_variations pv WHERE pv.id = v_pvid;

    ELSE

      SELECT COALESCE(SUM(sb.quantity), 0) INTO v_current_qty
      FROM stock_balances sb
      JOIN stock_locations sl ON sl.id = sb.stock_location_id
      WHERE sb.product_variation_id = v_pvid
        AND sl.company_id = v_company_id
        AND sl.active     = true;

      IF v_current_qty < v_qty THEN
        RAISE EXCEPTION
          'Estoque total insuficiente para venda online (variação #%). '
          'Disponível: %, solicitado: %.',
          v_pvid, v_current_qty, v_qty
          USING ERRCODE = 'P0001';
      END IF;

      v_remaining := v_qty;

      FOR v_online_loc IN
        SELECT sl.id AS location_id, sl.priority
        FROM stock_locations sl
        JOIN stock_balances sb ON sb.stock_location_id = sl.id
                              AND sb.product_variation_id = v_pvid
        WHERE sl.company_id = v_company_id
          AND sl.active     = true
          AND sb.quantity   > 0
        ORDER BY sl.priority ASC, sl.id ASC
      LOOP
        EXIT WHEN v_remaining = 0;

        SELECT COALESCE(quantity, 0) INTO v_loc_qty
        FROM stock_balances
        WHERE product_variation_id = v_pvid
          AND stock_location_id    = v_online_loc.location_id;

        v_debit     := LEAST(v_remaining, v_loc_qty);
        v_remaining := v_remaining - v_debit;

        UPDATE stock_balances
        SET quantity     = quantity - v_debit,
            last_updated = NOW()
        WHERE product_variation_id = v_pvid
          AND stock_location_id    = v_online_loc.location_id;

        INSERT INTO stock_movements (
          product_variation_id, product_id, type, quantity,
          previous_stock, new_stock, unit_cost, reference_id, company_id,
          source_location_id, movement_type, reference_type, created_by
        )
        SELECT
          v_pvid, pv.product_id,
          'sale', -v_debit,
          v_loc_qty, v_loc_qty - v_debit,
          v_unit_cost, v_sale_id::text, v_company_id,
          v_online_loc.location_id, 'sale', 'online_order', p_system_user_id
        FROM product_variations pv WHERE pv.id = v_pvid;

      END LOOP;

      IF v_remaining > 0 THEN
        RAISE EXCEPTION
          'Erro interno: não foi possível debitar % unidades restantes da variação #%.',
          v_remaining, v_pvid
          USING ERRCODE = 'P0001';
      END IF;

    END IF;

  END LOOP;

  -- ─── Finance entries ──────────────────────────────────────────────────────
  IF v_total > 0 THEN
    INSERT INTO finance_entries (
      type, category, description, amount, reference_date, sale_id, created_by, company_id
    )
    VALUES (
      'income', 'sale', 'Venda ' || v_sale_number,
      v_total, v_brazil_date, v_sale_id, p_system_user_id, v_company_id
    );
  END IF;

  -- ─── Pagamentos ──────────────────────────────────────────────────────────
  IF p_payments IS NOT NULL AND jsonb_array_length(p_payments) > 0 THEN
    FOR v_pmt IN SELECT value FROM jsonb_array_elements(p_payments) LOOP
      v_pmt_method     := (v_pmt->>'method')::payment_method;
      v_pmt_tendered   := COALESCE((v_pmt->>'amount_tendered')::numeric, 0);
      v_pmt_change     := COALESCE((v_pmt->>'change_amount')::numeric, 0);
      v_pmt_change_mth := v_pmt->>'change_method';
      v_pmt_net        := COALESCE((v_pmt->>'net_amount')::numeric, 0);
      v_pmt_install    := COALESCE((v_pmt->>'installments')::int, 1);
      v_pmt_brand      := v_pmt->>'card_brand';
      v_pmt_acquirer   := v_pmt->>'acquirer';
      v_pmt_fee        := COALESCE((v_pmt->>'fee_amount')::numeric, ROUND(v_pmt_net * v_card_fee / 100, 2));

      INSERT INTO sale_payments (
        sale_id, company_id, method,
        amount_tendered, change_amount, change_method,
        net_amount, installments, card_brand, acquirer, fee_amount
      )
      VALUES (
        v_sale_id, v_company_id, v_pmt_method,
        v_pmt_tendered, v_pmt_change,
        v_pmt_change_mth::payment_method,
        v_pmt_net, v_pmt_install, v_pmt_brand, v_pmt_acquirer, v_pmt_fee
      );
    END LOOP;
  END IF;

  -- ─── Gerar cashback earn (restaurado, ausente em v4) ─────────────────────
  -- Só gera se o cliente NÃO usou cashback nesta venda (cashback_action='accumulate').
  -- Condições: cliente identificado, não anônimo, config ativa, total >= mínimo.
  IF COALESCE(p_cashback_used, 0) = 0 AND p_customer_id IS NOT NULL THEN
    SELECT is_anonymous INTO v_is_anon
    FROM customers WHERE id = p_customer_id;

    IF NOT COALESCE(v_is_anon, false) THEN
      SELECT rate_pct, release_days, expiry_days, min_order_value
      INTO v_rate_pct, v_release_days, v_expiry_days, v_min_order
      FROM cashback_config
      WHERE company_id = v_company_id AND active = true
      LIMIT 1;

      IF FOUND AND v_total >= COALESCE(v_min_order, 0) THEN
        v_earn_amount  := ROUND(v_total * v_rate_pct / 100.0, 2);

        IF v_earn_amount > 0 THEN
          v_release_days := COALESCE(v_release_days, 0);
          v_expiry_days  := COALESCE(v_expiry_days, 0);
          v_earn_release := v_brazil_date + v_release_days;
          v_earn_status  := CASE WHEN v_release_days = 0
                                 THEN 'available'::cashback_status
                                 ELSE 'pending'::cashback_status END;
          v_earn_expiry  := CASE WHEN v_expiry_days > 0
                                 THEN v_earn_release + v_expiry_days
                                 ELSE NULL END;

          INSERT INTO cashback_transactions (
            customer_id, company_id, sale_id,
            type, amount, status,
            release_date, expiry_date
          )
          VALUES (
            p_customer_id, v_company_id, v_sale_id,
            'earn', v_earn_amount, v_earn_status,
            v_earn_release, v_earn_expiry
          );
        END IF;
      END IF;
    END IF;
  END IF;

  -- ─── Snapshot de destinatário/endereço de entrega (Fase Fiscal 5C — ──────
  -- Blocker 1, atomicidade). Mesma transação da venda: se qualquer INSERT
  -- abaixo falhar (violação de CHECK/NOT NULL, endereço selecionado que não
  -- pertence ao cliente, etc.), a exceção propaga e TODA a função sofre
  -- ROLLBACK — nenhuma venda órfã sem snapshot, nenhum snapshot sem venda.
  IF p_delivery_recipient IS NOT NULL THEN
    v_recip_source_addr_id := NULLIF(p_delivery_recipient->>'customer_address_id', '')::int;

    IF v_recip_source_addr_id IS NOT NULL THEN
      -- Endereço já cadastrado selecionado — NUNCA confia nos campos de
      -- endereço que vieram em paralelo no JSON; carrega do cadastro
      -- reutilizável, escopado ao MESMO cliente da venda (nunca a um
      -- customer_address de outro cliente/empresa).
      SELECT cep, street, number, complement, neighborhood, city, state, municipio_ibge, ibge_source
      INTO v_recip_addr
      FROM customer_addresses
      WHERE id = v_recip_source_addr_id
        AND customer_id = p_customer_id;

      IF NOT FOUND THEN
        RAISE EXCEPTION 'Endereço de entrega selecionado não encontrado para este cliente.' USING ERRCODE = 'P0001';
      END IF;

      v_recip_cep            := v_recip_addr.cep;
      v_recip_logradouro     := v_recip_addr.street;
      v_recip_numero         := v_recip_addr.number;
      v_recip_complemento    := v_recip_addr.complement;
      v_recip_bairro         := v_recip_addr.neighborhood;
      v_recip_municipio      := v_recip_addr.city;
      v_recip_uf              := v_recip_addr.state;
      v_recip_municipio_ibge  := v_recip_addr.municipio_ibge;
      v_recip_ibge_source     := v_recip_addr.ibge_source;

    ELSE
      v_recip_cep            := p_delivery_recipient->>'cep';
      v_recip_logradouro     := p_delivery_recipient->>'logradouro';
      v_recip_numero         := p_delivery_recipient->>'numero';
      v_recip_complemento    := p_delivery_recipient->>'complemento';
      v_recip_bairro         := p_delivery_recipient->>'bairro';
      v_recip_municipio      := p_delivery_recipient->>'municipio';
      v_recip_uf              := UPPER(p_delivery_recipient->>'uf');
      v_recip_municipio_ibge  := NULLIF(p_delivery_recipient->>'municipio_ibge', '');
      v_recip_ibge_source     := NULLIF(p_delivery_recipient->>'ibge_source', '');

      IF COALESCE((p_delivery_recipient->>'save_as_customer_address')::boolean, false) THEN
        IF p_customer_id IS NULL THEN
          RAISE EXCEPTION 'Não é possível salvar endereço reutilizável sem cliente identificado.' USING ERRCODE = 'P0001';
        END IF;

        INSERT INTO customer_addresses (
          customer_id, cep, street, number, complement, neighborhood, city, state,
          municipio_ibge, ibge_source
        )
        VALUES (
          p_customer_id, v_recip_cep, v_recip_logradouro, v_recip_numero, v_recip_complemento,
          v_recip_bairro, v_recip_municipio, v_recip_uf, v_recip_municipio_ibge, v_recip_ibge_source
        )
        RETURNING id INTO v_recip_source_addr_id;
      END IF;
    END IF;

    INSERT INTO sale_recipients (
      sale_id, company_id, source_address_id,
      nome, cpf, cnpj, telefone,
      cep, logradouro, numero, complemento, bairro, municipio, municipio_ibge, uf, ibge_source
    )
    VALUES (
      v_sale_id, v_company_id, v_recip_source_addr_id,
      p_delivery_recipient->>'nome',
      NULLIF(p_delivery_recipient->>'cpf', ''),
      NULLIF(p_delivery_recipient->>'cnpj', ''),
      NULLIF(p_delivery_recipient->>'telefone', ''),
      v_recip_cep, v_recip_logradouro, v_recip_numero, v_recip_complemento,
      v_recip_bairro, v_recip_municipio, v_recip_municipio_ibge, v_recip_uf, v_recip_ibge_source
    );
  END IF;

  -- ─── Evento de domínio (Fase 2 — Integration Foundation) ─────────────────
  INSERT INTO integration_outbox (
    company_id, event_id, event_type, aggregate_type, aggregate_id, payload
  )
  VALUES (
    v_company_id,
    'sale:' || v_sale_id || ':completed',
    'sale.completed',
    'sale',
    v_sale_id::text,
    jsonb_build_object(
      'sale_id',         v_sale_id,
      'sale_number',     v_sale_number,
      'customer_id',     p_customer_id,
      'total',           ROUND(v_total, 2),
      'payment_method',  COALESCE(v_dominant_method, p_payment_method),
      'sale_date',       v_brazil_date
    )
  );

  RETURN jsonb_build_object(
    'id',          v_sale_id,
    'sale_number', v_sale_number,
    'total',       ROUND(v_total, 2)
  );
END;
$$;

-- ═══════════════════════════════════════════════════════════════════════════════
-- Passo 3 — GRANT/REVOKE explícitos para a assinatura nova.
--
-- CORRIGIDO (evidência real do banco, trazida pelo usuário nesta revisão):
-- as DUAS assinaturas hoje vivas de rpc_create_sale (16 params + wrapper
-- de 12) têm grant EXECUTE EXPLÍCITO para PUBLIC, anon, authenticated,
-- service_role, postgres, supabase_admin — não é só herança de PUBLIC.
-- Isso é consistente com o comportamento conhecido de projetos Supabase:
-- a plataforma configura, fora da árvore de migrations de usuário
-- (`ALTER DEFAULT PRIVILEGES` de projeto, não encontrável por grep em
-- supabase/migrations/*.sql), privilégios default para `anon`/
-- `authenticated`/`service_role` em novos objetos do schema `public` —
-- por isso vários outros arquivos deste projeto já fazem `REVOKE ALL ...
-- FROM PUBLIC, anon, authenticated` explicitamente pra qualquer RPC
-- sensível (ver 20260627_authorization_tokens_v2.sql:23,
-- 20260816_fix_stock_media_repasse_rpc_grants_public.sql,
-- 202607302600_pim_product_sku_identity.sql — mesmo padrão, adotado aqui).
--
-- Revogar só `PUBLIC` (como a primeira versão desta correção fazia) NÃO
-- seria suficiente — `anon`/`authenticated` têm grant DIRETO e
-- independente, que uma revogação de PUBLIC não remove (privilégios de
-- Postgres se somam por caminho: role direto OU PUBLIC OU herança de
-- grupo — revogar um caminho nunca revoga os outros). Por isso os três
-- são revogados explicitamente abaixo, no mesmo `REVOKE`.
--
-- `postgres`/`supabase_admin` não são tocados — são papéis
-- administrativos/donos do banco (equivalentes à própria equipe, não à
-- superfície pública do app) e tipicamente bypassam checagem de ACL como
-- superusuário/dono do objeto de qualquer forma.
-- ═══════════════════════════════════════════════════════════════════════════════

REVOKE EXECUTE ON FUNCTION public.rpc_create_sale(
  int, uuid, payment_method, text, numeric, numeric, numeric, text,
  jsonb, uuid, numeric, numeric, jsonb, bigint, text, int, jsonb
) FROM PUBLIC, anon, authenticated;

GRANT EXECUTE ON FUNCTION public.rpc_create_sale(
  int, uuid, payment_method, text, numeric, numeric, numeric, text,
  jsonb, uuid, numeric, numeric, jsonb, bigint, text, int, jsonb
) TO service_role;
