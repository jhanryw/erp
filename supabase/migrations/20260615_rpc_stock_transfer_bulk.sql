-- =============================================================================
-- 20260615_rpc_stock_transfer_bulk.sql
--
-- Fase 2: Transferência em Massa de Estoque
--
-- O que esta migration faz:
--   Cria rpc_stock_transfer_bulk: RPC atômica para transferir múltiplos
--   produtos/variações entre dois locais de estoque em uma única transação.
--
-- Estratégia validate-all-first:
--   Bloco 1 — validações globais (origem, destino, tamanho do lote)
--   Bloco 2 — validação de cada item (acumula TODOS os erros, sem abortar)
--   Bloco 3 — se há erro(s), retorna ok:false sem tocar no banco
--   Bloco 4 — adquire locks em ordem determinística (previne deadlock)
--   Bloco 5 — executa todos os débitos/créditos e registra movements
--
-- Diferenças críticas em relação a rpc_transfer_stock (individual):
--   - avg_cost do destino usa custo médio ponderado em vez de sobrescrever
--   - Todos os stock_movements do lote compartilham o mesmo batch_id
--   - Erros são acumulados; nunca interrompe na primeira falha
--   - Rejeita product_variation_id duplicado no mesmo batch
--   - Limite de 200 itens por chamada
--
-- O que esta migration NÃO faz:
--   - Não altera rpc_transfer_stock (transferência individual inalterada)
--   - Não cria tabelas, triggers ou views
--   - Não registra stock_lots (transferência não é compra)
--   - Não cria lançamento financeiro (movimentação interna)
--
-- Dependências:
--   stock_balances, stock_movements, stock_locations,
--   product_variations, products
-- =============================================================================


CREATE OR REPLACE FUNCTION public.rpc_stock_transfer_bulk(
  p_from_location_id  int,
  p_to_location_id    int,
  p_notes             text,
  p_user_id           uuid,
  p_items             jsonb   -- [{product_variation_id: int, quantity: int}, ...]
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  -- Contexto dos locais
  v_company_id       int;
  v_from_company_id  int;
  v_to_company_id    int;
  v_item_company_id  int;
  v_item_count       int;

  -- Iteração
  v_row              record;
  rec                record;

  -- Valores extraídos do item JSON
  v_pvid_raw         text;
  v_qty_raw          text;
  v_pvid             int;
  v_qty              int;

  -- Controle de duplicatas no batch
  v_seen_pvids       int[] := '{}';

  -- Metadados do produto
  v_product_name     text;
  v_sku_variation    text;
  v_product_id       int;

  -- Saldos e custos
  v_from_qty         int;
  v_from_avg_cost    numeric;
  v_to_qty           int;
  v_to_avg_cost      numeric;
  v_new_avg_cost     numeric;
  v_check_qty        int;

  -- Acumuladores
  v_errors           jsonb := '[]'::jsonb;
  v_transferred      jsonb := '[]'::jsonb;
  v_batch_id         text;
  v_total_items      int   := 0;
  v_total_quantity   int   := 0;
BEGIN
  -- Permite escrita em stock_balances (bypassa trigger de proteção)
  PERFORM set_config('app.stock_rpc', '1', true);

  -- ═══════════════════════════════════════════════════════════════════════════
  -- BLOCO 1 — Validações globais
  -- Qualquer falha aqui retorna imediatamente (não faz sentido continuar).
  -- ═══════════════════════════════════════════════════════════════════════════

  -- 1a. Origem ≠ Destino
  IF p_from_location_id = p_to_location_id THEN
    RETURN jsonb_build_object('ok', false, 'errors', jsonb_build_array(
      jsonb_build_object(
        'product_variation_id', NULL,
        'product_name',         NULL,
        'sku_variation',        NULL,
        'quantity_requested',   NULL,
        'balance_available',    NULL,
        'reason',     'Origem e destino não podem ser iguais.',
        'suggestion', 'Selecione locais diferentes para origem e destino.'
      )
    ));
  END IF;

  -- 1b. Local de origem existe e está ativo
  SELECT company_id INTO v_from_company_id
  FROM public.stock_locations
  WHERE id = p_from_location_id AND active = true;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'errors', jsonb_build_array(
      jsonb_build_object(
        'product_variation_id', NULL,
        'product_name',         NULL,
        'sku_variation',        NULL,
        'quantity_requested',   NULL,
        'balance_available',    NULL,
        'reason',     format('Local de origem #%s não encontrado ou inativo.', p_from_location_id),
        'suggestion', 'Verifique se o local de estoque de origem está ativo.'
      )
    ));
  END IF;

  -- 1c. Local de destino existe e está ativo
  SELECT company_id INTO v_to_company_id
  FROM public.stock_locations
  WHERE id = p_to_location_id AND active = true;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'errors', jsonb_build_array(
      jsonb_build_object(
        'product_variation_id', NULL,
        'product_name',         NULL,
        'sku_variation',        NULL,
        'quantity_requested',   NULL,
        'balance_available',    NULL,
        'reason',     format('Local de destino #%s não encontrado ou inativo.', p_to_location_id),
        'suggestion', 'Verifique se o local de estoque de destino está ativo.'
      )
    ));
  END IF;

  -- 1d. Ambos os locais pertencem à mesma empresa
  IF v_from_company_id <> v_to_company_id THEN
    RETURN jsonb_build_object('ok', false, 'errors', jsonb_build_array(
      jsonb_build_object(
        'product_variation_id', NULL,
        'product_name',         NULL,
        'sku_variation',        NULL,
        'quantity_requested',   NULL,
        'balance_available',    NULL,
        'reason',     'Origem e destino pertencem a empresas diferentes.',
        'suggestion', 'Selecione locais da mesma empresa.'
      )
    ));
  END IF;

  v_company_id := v_from_company_id;

  -- 1e. Lista de itens não é nula nem vazia
  v_item_count := jsonb_array_length(COALESCE(p_items, '[]'::jsonb));

  IF v_item_count = 0 THEN
    RETURN jsonb_build_object('ok', false, 'errors', jsonb_build_array(
      jsonb_build_object(
        'product_variation_id', NULL,
        'product_name',         NULL,
        'sku_variation',        NULL,
        'quantity_requested',   NULL,
        'balance_available',    NULL,
        'reason',     'Nenhum item informado.',
        'suggestion', 'Selecione ao menos um produto para transferir.'
      )
    ));
  END IF;

  -- 1f. Limite máximo de 200 itens por batch
  IF v_item_count > 200 THEN
    RETURN jsonb_build_object('ok', false, 'errors', jsonb_build_array(
      jsonb_build_object(
        'product_variation_id', NULL,
        'product_name',         NULL,
        'sku_variation',        NULL,
        'quantity_requested',   NULL,
        'balance_available',    NULL,
        'reason',     format('Limite máximo de 200 itens por transferência. Recebido: %s.', v_item_count),
        'suggestion', 'Divida em lotes de até 200 itens.'
      )
    ));
  END IF;

  -- ═══════════════════════════════════════════════════════════════════════════
  -- BLOCO 2 — Validação individual de cada item
  -- Nunca aborta na primeira falha: acumula todos os erros para retorná-los
  -- de uma vez, permitindo que a UI mostre todos os problemas ao usuário.
  -- ═══════════════════════════════════════════════════════════════════════════

  FOR v_row IN SELECT value FROM jsonb_array_elements(p_items)
  LOOP
    v_pvid_raw := v_row.value->>'product_variation_id';
    v_qty_raw  := v_row.value->>'quantity';

    -- 2a. product_variation_id deve ser inteiro positivo
    v_pvid := CASE
      WHEN v_pvid_raw ~ '^[1-9]\d*$' THEN v_pvid_raw::int
      ELSE NULL
    END;

    IF v_pvid IS NULL THEN
      v_errors := v_errors || jsonb_build_object(
        'product_variation_id', v_pvid_raw,
        'product_name',         NULL,
        'sku_variation',        NULL,
        'quantity_requested',   NULL,
        'balance_available',    NULL,
        'reason',     'product_variation_id inválido ou ausente.',
        'suggestion', 'Informe um ID de variação inteiro e positivo.'
      );
      CONTINUE;
    END IF;

    -- 2b. Quantidade deve ser inteiro positivo
    v_qty := CASE
      WHEN v_qty_raw ~ '^[1-9]\d*$' THEN v_qty_raw::int
      ELSE NULL
    END;

    IF v_qty IS NULL THEN
      v_errors := v_errors || jsonb_build_object(
        'product_variation_id', v_pvid,
        'product_name',         NULL,
        'sku_variation',        NULL,
        'quantity_requested',   v_qty_raw,
        'balance_available',    NULL,
        'reason',     'Quantidade deve ser maior que zero.',
        'suggestion', 'Informe uma quantidade inteira e positiva para este item.'
      );
      CONTINUE;
    END IF;

    -- 2c. Rejeitar duplicatas no mesmo batch
    IF v_pvid = ANY(v_seen_pvids) THEN
      -- Tentar buscar nome do produto para enriquecer o erro
      SELECT p.name, pv.sku_variation
      INTO v_product_name, v_sku_variation
      FROM public.product_variations pv
      JOIN public.products p ON p.id = pv.product_id
      WHERE pv.id = v_pvid;

      v_errors := v_errors || jsonb_build_object(
        'product_variation_id', v_pvid,
        'product_name',         v_product_name,
        'sku_variation',        v_sku_variation,
        'quantity_requested',   v_qty,
        'balance_available',    NULL,
        'reason',     'Variação duplicada no lote.',
        'suggestion', 'Some as quantidades em uma única linha.'
      );
      CONTINUE;
    END IF;

    v_seen_pvids := array_append(v_seen_pvids, v_pvid);

    -- 2d. Variação deve existir e estar ativa
    SELECT p.name, pv.sku_variation, pv.product_id, p.company_id
    INTO   v_product_name, v_sku_variation, v_product_id, v_item_company_id
    FROM   public.product_variations pv
    JOIN   public.products           p ON p.id = pv.product_id
    WHERE  pv.id = v_pvid AND pv.active = true;

    IF NOT FOUND THEN
      v_errors := v_errors || jsonb_build_object(
        'product_variation_id', v_pvid,
        'product_name',         NULL,
        'sku_variation',        NULL,
        'quantity_requested',   v_qty,
        'balance_available',    NULL,
        'reason',     format('Variação #%s não encontrada ou inativa.', v_pvid),
        'suggestion', 'Verifique se o produto está ativo no sistema.'
      );
      CONTINUE;
    END IF;

    -- 2e. Variação deve pertencer à mesma empresa dos locais
    IF v_item_company_id <> v_company_id THEN
      v_errors := v_errors || jsonb_build_object(
        'product_variation_id', v_pvid,
        'product_name',         v_product_name,
        'sku_variation',        v_sku_variation,
        'quantity_requested',   v_qty,
        'balance_available',    NULL,
        'reason',     'Variação não pertence à empresa dos locais de estoque selecionados.',
        'suggestion', 'Verifique os locais de origem e destino.'
      );
      CONTINUE;
    END IF;

    -- 2f. Verificar saldo na origem
    SELECT COALESCE(quantity, 0), COALESCE(avg_cost, 0)
    INTO   v_from_qty, v_from_avg_cost
    FROM   public.stock_balances
    WHERE  product_variation_id = v_pvid
      AND  stock_location_id    = p_from_location_id;

    v_from_qty := COALESCE(v_from_qty, 0);

    IF v_from_qty = 0 THEN
      v_errors := v_errors || jsonb_build_object(
        'product_variation_id', v_pvid,
        'product_name',         v_product_name,
        'sku_variation',        v_sku_variation,
        'quantity_requested',   v_qty,
        'balance_available',    0,
        'reason',     'Produto sem saldo no local de origem.',
        'suggestion', 'Este item não possui estoque disponível na origem. Verifique o local selecionado.'
      );
      CONTINUE;
    END IF;

    IF v_from_qty < v_qty THEN
      v_errors := v_errors || jsonb_build_object(
        'product_variation_id', v_pvid,
        'product_name',         v_product_name,
        'sku_variation',        v_sku_variation,
        'quantity_requested',   v_qty,
        'balance_available',    v_from_qty,
        'reason',     format('Saldo insuficiente. Disponível: %s, solicitado: %s.', v_from_qty, v_qty),
        'suggestion', format('Reduza a quantidade para no máximo %s unidades.', v_from_qty)
      );
      CONTINUE;
    END IF;

  END LOOP;

  -- ═══════════════════════════════════════════════════════════════════════════
  -- BLOCO 3 — Retorno antecipado em caso de erro(s)
  -- Nenhuma linha de stock_balances/stock_movements foi tocada até aqui.
  -- ═══════════════════════════════════════════════════════════════════════════

  IF jsonb_array_length(v_errors) > 0 THEN
    RETURN jsonb_build_object('ok', false, 'errors', v_errors);
  END IF;

  -- ═══════════════════════════════════════════════════════════════════════════
  -- BLOCO 4 — Locks em ordem determinística
  --
  -- Todos os pares (product_variation_id × stock_location_id) são ordenados
  -- por (pvid ASC, loc_id ASC) antes de bloquear.
  -- Isso previne deadlock mesmo que duas transações concorrentes transfiram
  -- os mesmos produtos em direções opostas.
  --
  -- Nota: bloqueia apenas as linhas existentes em stock_balances.
  -- Linhas inexistentes no destino serão criadas pelo INSERT que vem depois,
  -- protegidas pela transação corrente.
  -- ═══════════════════════════════════════════════════════════════════════════

  FOR rec IN
    SELECT DISTINCT t.pvid, t.loc_id
    FROM (
      SELECT
        (elem->>'product_variation_id')::int                            AS pvid,
        unnest(ARRAY[p_from_location_id, p_to_location_id])            AS loc_id
      FROM jsonb_array_elements(p_items) AS elem
    ) t
    ORDER BY t.pvid ASC, t.loc_id ASC
  LOOP
    PERFORM 1
    FROM  public.stock_balances
    WHERE product_variation_id = rec.pvid
      AND stock_location_id    = rec.loc_id
    FOR UPDATE;
  END LOOP;

  -- ═══════════════════════════════════════════════════════════════════════════
  -- BLOCO 5 — Execução das transferências
  --
  -- Todos os itens foram validados e todos os locks foram adquiridos.
  -- Os saldos são relidos pós-lock para garantir consistência contra
  -- race conditions com transações concorrentes.
  -- ═══════════════════════════════════════════════════════════════════════════

  v_batch_id := gen_random_uuid()::text;

  FOR v_row IN SELECT value FROM jsonb_array_elements(p_items)
  LOOP
    v_pvid := (v_row.value->>'product_variation_id')::int;
    v_qty  := (v_row.value->>'quantity')::int;

    -- Reler metadados do produto (necessário para o INSERT em stock_movements)
    SELECT p.name, pv.sku_variation, pv.product_id
    INTO   v_product_name, v_sku_variation, v_product_id
    FROM   public.product_variations pv
    JOIN   public.products           p ON p.id = pv.product_id
    WHERE  pv.id = v_pvid;

    -- Reler saldos pós-lock (valores garantidos correntes após aquisição dos locks)
    SELECT COALESCE(quantity, 0), COALESCE(avg_cost, 0)
    INTO   v_from_qty, v_from_avg_cost
    FROM   public.stock_balances
    WHERE  product_variation_id = v_pvid
      AND  stock_location_id    = p_from_location_id;

    v_from_qty      := COALESCE(v_from_qty, 0);
    v_from_avg_cost := COALESCE(v_from_avg_cost, 0);

    -- Verificar saldo pós-lock (protege contra race condition entre validação e escrita)
    IF v_from_qty < v_qty THEN
      RAISE EXCEPTION
        'Saldo alterado por operação concorrente para variação #% (SKU: %). '
        'Disponível agora: %, solicitado: %. Tente novamente.',
        v_pvid, v_sku_variation, v_from_qty, v_qty
      USING ERRCODE = 'P0001';
    END IF;

    -- Reler saldo e custo do destino para calcular novo custo médio ponderado
    SELECT COALESCE(quantity, 0), COALESCE(avg_cost, 0)
    INTO   v_to_qty, v_to_avg_cost
    FROM   public.stock_balances
    WHERE  product_variation_id = v_pvid
      AND  stock_location_id    = p_to_location_id;

    v_to_qty      := COALESCE(v_to_qty, 0);
    v_to_avg_cost := COALESCE(v_to_avg_cost, 0);

    -- Custo médio ponderado para o destino após receber as unidades.
    -- Quando destino está zerado (v_to_qty = 0), simplifica para v_from_avg_cost.
    -- Fórmula: ((qty_destino × avg_destino) + (qty_transferida × avg_origem))
    --          / (qty_destino + qty_transferida)
    IF (v_to_qty + v_qty) > 0 THEN
      v_new_avg_cost := ROUND(
        ( (v_to_qty::numeric      * v_to_avg_cost)
        + (v_qty::numeric         * v_from_avg_cost) )
        / (v_to_qty + v_qty)::numeric
      , 4);
    ELSE
      v_new_avg_cost := v_from_avg_cost;
    END IF;

    -- ── Debitar da origem ──────────────────────────────────────────────────
    -- A linha sempre existe (validamos v_from_qty > 0 no bloco 2).
    -- Não alteramos avg_cost da origem: o custo médio dos lotes restantes
    -- não muda com a saída de unidades.
    UPDATE public.stock_balances
    SET    quantity     = quantity - v_qty,
           last_updated = NOW()
    WHERE  product_variation_id = v_pvid
      AND  stock_location_id    = p_from_location_id;

    -- Verificação extra: CHECK constraint (quantity >= 0) já protege, mas
    -- esta leitura garante mensagem P0001 clara caso algo inesperado ocorra.
    SELECT quantity INTO v_check_qty
    FROM   public.stock_balances
    WHERE  product_variation_id = v_pvid
      AND  stock_location_id    = p_from_location_id;

    IF v_check_qty < 0 THEN
      RAISE EXCEPTION
        'Inconsistência interna: saldo ficou negativo para variação #% após débito.',
        v_pvid
      USING ERRCODE = 'P0001';
    END IF;

    -- ── Creditar no destino ────────────────────────────────────────────────
    -- INSERT se ainda não existe linha para este par (pvid, destino).
    -- UPDATE se já existe, com recálculo do custo médio ponderado.
    INSERT INTO public.stock_balances
      (product_variation_id, stock_location_id, quantity, avg_cost, last_updated)
    VALUES
      (v_pvid, p_to_location_id, v_qty, v_new_avg_cost, NOW())
    ON CONFLICT (product_variation_id, stock_location_id) DO UPDATE
      SET quantity     = public.stock_balances.quantity + v_qty,
          avg_cost     = v_new_avg_cost,
          last_updated = NOW();

    -- ── Registrar movimento ────────────────────────────────────────────────
    -- Um movimento por item, todos com o mesmo batch_id como reference_id.
    -- previous_stock e new_stock refletem o saldo da ORIGEM antes e após o débito.
    -- type = NULL mantém compatibilidade com o padrão legado de transferências.
    INSERT INTO public.stock_movements (
      product_variation_id,
      product_id,
      type,
      quantity,
      previous_stock,
      new_stock,
      unit_cost,
      reference_id,
      company_id,
      source_location_id,
      destination_location_id,
      movement_type,
      reference_type,
      notes,
      created_by
    )
    VALUES (
      v_pvid,
      v_product_id,
      NULL,                   -- type legado: NULL para transferências
      v_qty,
      v_from_qty,             -- saldo da origem ANTES do débito
      v_from_qty - v_qty,     -- saldo da origem APÓS o débito
      v_from_avg_cost,
      v_batch_id,             -- mesmo batch_id para todos os itens do lote
      v_company_id,
      p_from_location_id,
      p_to_location_id,
      'transfer',
      'transfer',
      p_notes,
      p_user_id
    );

    -- ── Acumular no resultado ──────────────────────────────────────────────
    v_transferred := v_transferred || jsonb_build_object(
      'product_variation_id', v_pvid,
      'product_name',         v_product_name,
      'sku_variation',        v_sku_variation,
      'quantity',             v_qty,
      'unit_cost',            v_from_avg_cost,
      'from_qty_before',      v_from_qty,
      'from_qty_after',       v_from_qty - v_qty,
      'to_qty_before',        v_to_qty,
      'to_qty_after',         v_to_qty + v_qty,
      'to_avg_cost_after',    v_new_avg_cost
    );

    v_total_items    := v_total_items    + 1;
    v_total_quantity := v_total_quantity + v_qty;

  END LOOP;

  -- ── Retorno de sucesso ─────────────────────────────────────────────────────
  RETURN jsonb_build_object(
    'ok',               true,
    'batch_id',         v_batch_id,
    'from_location_id', p_from_location_id,
    'to_location_id',   p_to_location_id,
    'total_items',      v_total_items,
    'total_quantity',   v_total_quantity,
    'transferred',      v_transferred
  );

END;
$$;


GRANT EXECUTE ON FUNCTION public.rpc_stock_transfer_bulk(int, int, text, uuid, jsonb)
  TO authenticated, service_role;


-- =============================================================================
-- Queries de validação (rodar após aplicar no Supabase)
--
-- Substitua os valores <...> pelos IDs reais do seu banco.
-- Use auth.uid() no SQL Editor para obter o UUID do usuário logado.
-- =============================================================================

-- 1. Verificar que a função foi criada
--    SELECT routine_name, routine_type
--    FROM information_schema.routines
--    WHERE routine_schema = 'public'
--      AND routine_name   = 'rpc_stock_transfer_bulk';
--    → deve retornar 1 linha com FUNCTION

-- 2. Verificar GRANT
--    SELECT grantee, privilege_type
--    FROM information_schema.routine_privileges
--    WHERE routine_name = 'rpc_stock_transfer_bulk';
--    → deve retornar linhas para authenticated e service_role

-- 3. Teste: origem = destino (erro global)
--    SELECT rpc_stock_transfer_bulk(
--      1, 1, 'teste', auth.uid(),
--      '[{"product_variation_id": 1, "quantity": 1}]'::jsonb
--    );
--    → esperado: { ok: false, errors: [{ reason: "Origem e destino não podem ser iguais." }] }

-- 4. Teste: local de origem inexistente
--    SELECT rpc_stock_transfer_bulk(
--      9999, <to_id>, 'teste', auth.uid(),
--      '[{"product_variation_id": 1, "quantity": 1}]'::jsonb
--    );
--    → esperado: { ok: false, errors: [{ reason: "Local de origem #9999 não encontrado ou inativo." }] }

-- 5. Teste: variação duplicada no batch
--    SELECT rpc_stock_transfer_bulk(
--      <from_id>, <to_id>, 'teste', auth.uid(),
--      '[
--        {"product_variation_id": <pvid>, "quantity": 1},
--        {"product_variation_id": <pvid>, "quantity": 2}
--      ]'::jsonb
--    );
--    → esperado: { ok: false, errors: [{ reason: "Variação duplicada no lote." }] }

-- 6. Teste: quantidade inválida + saldo insuficiente ao mesmo tempo
--    SELECT rpc_stock_transfer_bulk(
--      <from_id>, <to_id>, 'teste', auth.uid(),
--      '[
--        {"product_variation_id": <pvid_valido>, "quantity": 0},
--        {"product_variation_id": <pvid_valido2>, "quantity": 9999}
--      ]'::jsonb
--    );
--    → esperado: { ok: false, errors: [...2 erros...] }

-- 7. Teste: limite de 200 itens
--    SELECT rpc_stock_transfer_bulk(
--      <from_id>, <to_id>, 'teste', auth.uid(),
--      (SELECT jsonb_agg(jsonb_build_object('product_variation_id', n, 'quantity', 1))
--       FROM generate_series(1, 201) n)
--    );
--    → esperado: { ok: false, errors: [{ reason: "Limite máximo de 200 itens..." }] }

-- 8. Teste de sucesso: transferência real (use pvids com saldo real na origem)
--    SELECT rpc_stock_transfer_bulk(
--      <from_id>, <to_id>, 'Teste bulk', auth.uid(),
--      '[{"product_variation_id": <pvid_com_saldo>, "quantity": 1}]'::jsonb
--    );
--    → esperado: { ok: true, batch_id: "uuid", total_items: 1, total_quantity: 1, transferred: [...] }

-- 9. Verificar movement registrado após teste 8
--    SELECT movement_type, reference_type, reference_id AS batch_id,
--           quantity, previous_stock, new_stock, unit_cost,
--           source_location_id, destination_location_id
--    FROM stock_movements
--    WHERE reference_id = '<batch_id_retornado>'
--    ORDER BY created_at DESC;
--    → deve retornar 1 linha por item transferido, todas com o mesmo batch_id

-- 10. Verificar avg_cost ponderado no destino após teste 8
--     SELECT product_variation_id, stock_location_id, quantity, avg_cost
--     FROM stock_balances
--     WHERE product_variation_id = <pvid_transferido>
--     ORDER BY stock_location_id;
--     → origem: quantity reduzida; destino: quantity + v_qty, avg_cost ponderado

-- 11. Confirmar que rpc_transfer_stock individual ainda funciona
--     SELECT rpc_transfer_stock(<pvid>, <from_id>, <to_id>, 1, 'teste', auth.uid());
--     → deve retornar transfer_id normalmente (sem alteração)
-- =============================================================================
