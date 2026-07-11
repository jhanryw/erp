-- =============================================================================
-- 20260716_block_cash_expense_manual.sql
--
-- Bloqueia a criação manual de cash_movements com type = 'expense' através da
-- RPC genérica rpc_add_cash_movement (único caminho de escrita usado pela
-- tela de Caixa / POST /api/caixa/movimentos — confirmado por auditoria: não
-- há outro caller desta RPC no repositório).
--
-- Despesas devem ser cadastradas no módulo Financeiro (finance_entries).
--
-- NÃO remove 'expense' da CHECK constraint de cash_movements: registros
-- históricos continuam válidos, e uma futura RPC dedicada de pagamento em
-- dinheiro (entrega futura do plano de correção Caixa × Financeiro) poderá
-- voltar a inserir type='expense' por um caminho próprio, fora deste bloqueio.
--
-- Não altera nenhuma linha existente. Não altera a tabela. Só substitui a
-- função (CREATE OR REPLACE) — idempotente.
-- =============================================================================

CREATE OR REPLACE FUNCTION public.rpc_add_cash_movement(
  p_session_id        bigint,
  p_user_id           uuid,
  p_type              text,
  p_amount            numeric,
  p_description       text,
  p_method            text     DEFAULT 'cash',
  p_reference_sale_id bigint   DEFAULT NULL,
  p_metadata          jsonb    DEFAULT '{}'
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_company_id    int;
  v_sess_status   text;
  v_sess_company  int;
  v_movement_id   bigint;
  v_created_at    timestamptz;
BEGIN
  -- ─── Bloqueio (novo) ─────────────────────────────────────────────────────────
  -- Despesa não pode mais ser criada pelo caminho genérico do Caixa.
  IF p_type = 'expense' THEN
    RAISE EXCEPTION
      'Despesas devem ser cadastradas no módulo Financeiro. O Caixa registra apenas movimentações físicas de entrada e retirada.'
      USING ERRCODE = 'P0001';
  END IF;

  -- Validações de input (antes de qualquer query) — inalteradas, exceto que
  -- 'expense' saiu da lista de tipos aceitos.
  IF p_type NOT IN ('sangria', 'suprimento') THEN
    RAISE EXCEPTION 'Tipo inválido: %. Use sangria ou suprimento.', p_type
      USING ERRCODE = 'P0001';
  END IF;

  IF p_method NOT IN ('cash', 'pix', 'credit_card', 'debit_card') THEN
    RAISE EXCEPTION 'Método inválido: %.', p_method USING ERRCODE = 'P0001';
  END IF;

  IF p_type IN ('sangria', 'suprimento') AND p_method != 'cash' THEN
    RAISE EXCEPTION 'Sangria e suprimento são sempre em dinheiro físico. Método recebido: %.', p_method
      USING ERRCODE = 'P0001';
  END IF;

  IF COALESCE(p_amount, 0) <= 0 THEN
    RAISE EXCEPTION 'Valor deve ser maior que zero.' USING ERRCODE = 'P0001';
  END IF;

  IF TRIM(COALESCE(p_description, '')) = '' THEN
    RAISE EXCEPTION 'Descrição obrigatória.' USING ERRCODE = 'P0001';
  END IF;

  -- Empresa do usuário
  SELECT company_id INTO v_company_id FROM users WHERE id = p_user_id;
  IF v_company_id IS NULL THEN
    RAISE EXCEPTION 'Usuário não associado a uma empresa.' USING ERRCODE = 'P0001';
  END IF;

  -- Verificar sessão
  SELECT status, company_id
  INTO   v_sess_status, v_sess_company
  FROM   cash_register_sessions
  WHERE  id = p_session_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Sessão de caixa #% não encontrada.', p_session_id USING ERRCODE = 'P0001';
  END IF;
  IF v_sess_status = 'closed' THEN
    RAISE EXCEPTION 'Caixa fechado. Não é possível registrar movimentos.' USING ERRCODE = 'P0001';
  END IF;
  IF v_sess_company != v_company_id THEN
    RAISE EXCEPTION 'Acesso negado à sessão de caixa.' USING ERRCODE = 'P0001';
  END IF;

  -- Inserir movimento
  INSERT INTO cash_movements (
    cash_session_id,
    company_id,
    type,
    method,
    amount,
    description,
    reference_sale_id,
    metadata,
    created_by
  )
  VALUES (
    p_session_id,
    v_company_id,
    p_type,
    p_method,
    p_amount,
    TRIM(p_description),
    p_reference_sale_id,
    COALESCE(p_metadata, '{}'),
    p_user_id
  )
  RETURNING id, created_at INTO v_movement_id, v_created_at;

  RETURN jsonb_build_object(
    'id',         v_movement_id,
    'type',       p_type,
    'method',     p_method,
    'amount',     p_amount,
    'created_at', v_created_at
  );
END;
$$;

-- =============================================================================
-- Smoke test inline
-- =============================================================================

-- Confirma que a função foi substituída e contém o bloqueio
SELECT
  CASE
    WHEN prosrc LIKE '%p_type = ''expense''%' THEN 'OK: bloqueio de expense presente na função'
    ELSE 'FALHA: bloqueio não encontrado — migration não aplicada corretamente'
  END AS smoke_test
FROM pg_proc
WHERE proname = 'rpc_add_cash_movement';
-- Esperado: 1 linha, 'OK: bloqueio de expense presente na função'

-- Confirma que a CHECK constraint da tabela NÃO foi alterada (expense continua permitido)
SELECT pg_get_constraintdef(oid) AS check_definition
FROM pg_constraint
WHERE conrelid = 'public.cash_movements'::regclass
  AND contype = 'c'
  AND conname = 'cash_movements_type_check';
-- Esperado: CHECK ((type = ANY (ARRAY['sangria'::text, 'suprimento'::text, 'expense'::text])))

-- =============================================================================
-- FIM DA MIGRATION 20260716
-- =============================================================================
