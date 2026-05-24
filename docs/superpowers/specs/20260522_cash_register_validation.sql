-- =============================================================================
-- Validação pós-migration: Módulo de Caixa (20260522)
--
-- Cobre:
--   PASSO 0  — confirmar usuário admin disponível
--   TESTE 1  — verificar tabelas criadas
--   TESTE 2  — verificar índices críticos
--   TESTE 3  — verificar constraints de integridade
--   TESTE 4  — abertura de caixa (rpc_open_cash_session)
--   TESTE 5  — tentativa de dupla abertura (deve rejeitar)
--   TESTE 6  — adicionar movimento e fechar caixa (snapshot completo)
--   TESTE 7  — cancelamento lógico de movimento (rpc_cancel_cash_movement)
--   TESTE 8  — bloquear operações em caixa fechado
--
-- Execute cada bloco BEGIN/ROLLBACK SEPARADAMENTE no SQL Editor do Supabase.
-- Blocos sem transação (PASSOSs 0-3) podem ser executados diretamente.
-- Todos os blocos com BEGIN terminam em ROLLBACK — nenhum dado é persistido.
-- =============================================================================

-- =============================================================================
-- PASSO 0 — Confirmar pré-requisitos
-- Deve retornar 1 linha com seller_id, company_id e um admin/gerente
-- Se retornar vazio, crie um usuário admin antes de continuar.
-- =============================================================================

SELECT
  u.id          AS user_id,
  u.role        AS role,
  u.company_id  AS company_id
FROM users u
WHERE u.role IN ('admin', 'gerente')
  AND u.company_id IS NOT NULL
LIMIT 1;
-- Esperado: 1 linha

-- =============================================================================
-- TESTE 1 — Tabelas criadas
-- Esperado: 2 linhas (cash_movements, cash_register_sessions)
-- =============================================================================

SELECT table_name
FROM   information_schema.tables
WHERE  table_schema = 'public'
  AND  table_name   IN ('cash_register_sessions', 'cash_movements')
ORDER  BY table_name;
-- Esperado: 2 linhas

-- cash_session_id em sales?
SELECT column_name, data_type, is_nullable
FROM   information_schema.columns
WHERE  table_schema = 'public'
  AND  table_name   = 'sales'
  AND  column_name  = 'cash_session_id';
-- Esperado: 1 linha | bigint | YES

-- =============================================================================
-- TESTE 2 — Índices críticos
-- Esperado: 6 linhas (um por índice listado)
-- =============================================================================

SELECT indexname, tablename
FROM   pg_indexes
WHERE  tablename IN ('cash_register_sessions', 'cash_movements', 'sales')
  AND  indexname IN (
    'idx_cash_sessions_one_open_per_company',   -- partial unique (apenas 1 aberto por empresa)
    'idx_cash_sessions_company_opened',
    'idx_cash_movements_session',
    'idx_cash_movements_active',
    'idx_cash_movements_company_date',
    'idx_sales_cash_session'
  )
ORDER BY tablename, indexname;
-- Esperado: 6 linhas

-- Confirmar que o índice one_open_per_company é partial (WHERE status = 'open')
SELECT indexdef
FROM   pg_indexes
WHERE  indexname = 'idx_cash_sessions_one_open_per_company';
-- Esperado: contém "WHERE (status = 'open')"

-- =============================================================================
-- TESTE 3 — Constraints de integridade
-- Esperado: pelo menos 5 constraints listadas
-- =============================================================================

SELECT conname, contype, conrelid::regclass AS tabela
FROM   pg_constraint
WHERE  conrelid::regclass::text IN ('cash_register_sessions', 'cash_movements')
  AND  conname IN (
    'crs_closed_requires_closed_at',
    'crs_closed_requires_counted_cash',
    'crs_closed_by_with_closed_at',
    'cm_sangria_suprimento_cash_only',
    'cm_cancel_coherence'
  )
ORDER BY tabela, conname;
-- Esperado: 5 linhas

-- =============================================================================
-- TESTE 4 — Abertura de caixa (rpc_open_cash_session)
-- Esperado: jsonb com id, opened_at, opening_amount_cash = 200.00
--           + 1 linha em cash_register_sessions com status='open'
-- =============================================================================

BEGIN;

SELECT public.rpc_open_cash_session(
  p_user_id             := (SELECT id FROM users WHERE role IN ('admin','gerente') AND company_id IS NOT NULL LIMIT 1),
  p_opening_amount_cash := 200.00,
  p_notes               := 'TESTE 4 — abertura normal'
) AS resultado;

-- Verificar registro na tabela
SELECT
  id,
  status,
  opening_amount_cash,
  notes_open,
  closed_at
FROM cash_register_sessions
WHERE company_id = (
  SELECT company_id FROM users WHERE role IN ('admin','gerente') AND company_id IS NOT NULL LIMIT 1
)
ORDER BY opened_at DESC
LIMIT 1;
-- Esperado: status='open', opening_amount_cash=200.00, closed_at=NULL

ROLLBACK;

-- =============================================================================
-- TESTE 5 — Dupla abertura (deve rejeitar)
-- Esperado: EXCEPTION 'Já existe um caixa aberto para esta empresa.'
--           O bloco deve falhar com SQLSTATE P0001.
-- =============================================================================

BEGIN;

-- Abrir o primeiro caixa
SELECT public.rpc_open_cash_session(
  p_user_id             := (SELECT id FROM users WHERE role IN ('admin','gerente') AND company_id IS NOT NULL LIMIT 1),
  p_opening_amount_cash := 100.00,
  p_notes               := 'TESTE 5 — primeiro caixa'
);

-- Tentar abrir segundo caixa (DEVE LANÇAR EXCEÇÃO)
SELECT public.rpc_open_cash_session(
  p_user_id             := (SELECT id FROM users WHERE role IN ('admin','gerente') AND company_id IS NOT NULL LIMIT 1),
  p_opening_amount_cash := 50.00,
  p_notes               := 'TESTE 5 — segundo caixa (deve falhar)'
);

ROLLBACK;
-- Esperado: "ERROR: Já existe um caixa aberto para esta empresa."

-- =============================================================================
-- TESTE 6 — Fluxo completo: abertura → movimentos → fechamento com snapshot
--
-- Sequência:
--   1. Abre caixa com R$ 100,00
--   2. Registra suprimento de R$ 50,00
--   3. Registra sangria de R$ 30,00
--   4. Registra despesa em dinheiro de R$ 20,00
--   5. Fecha o caixa informando R$ 110,00 contados
--
-- Cálculo esperado de expected_cash:
--   100 (abertura)
--   + 50 (suprimento)
--   - 30 (sangria)
--   - 20 (despesa em cash)
--   = R$ 100,00
--
-- cash_difference = 110 - 100 = +10,00 (sobra no caixa)
-- =============================================================================

BEGIN;

-- 1. Abrir caixa
SELECT public.rpc_open_cash_session(
  p_user_id             := (SELECT id FROM users WHERE role IN ('admin','gerente') AND company_id IS NOT NULL LIMIT 1),
  p_opening_amount_cash := 100.00,
  p_notes               := 'TESTE 6 — fundo de caixa'
) AS abertura;

-- 2. Suprimento R$ 50,00
SELECT public.rpc_add_cash_movement(
  p_session_id  := (SELECT id FROM cash_register_sessions WHERE company_id = (SELECT company_id FROM users WHERE role IN ('admin','gerente') AND company_id IS NOT NULL LIMIT 1) AND status = 'open' LIMIT 1),
  p_user_id     := (SELECT id FROM users WHERE role IN ('admin','gerente') AND company_id IS NOT NULL LIMIT 1),
  p_type        := 'suprimento',
  p_method      := 'cash',
  p_amount      := 50.00,
  p_description := 'TESTE 6 — suprimento de troco'
) AS suprimento;

-- 3. Sangria R$ 30,00
SELECT public.rpc_add_cash_movement(
  p_session_id  := (SELECT id FROM cash_register_sessions WHERE company_id = (SELECT company_id FROM users WHERE role IN ('admin','gerente') AND company_id IS NOT NULL LIMIT 1) AND status = 'open' LIMIT 1),
  p_user_id     := (SELECT id FROM users WHERE role IN ('admin','gerente') AND company_id IS NOT NULL LIMIT 1),
  p_type        := 'sangria',
  p_method      := 'cash',
  p_amount      := 30.00,
  p_description := 'TESTE 6 — sangria parcial'
) AS sangria;

-- 4. Despesa em dinheiro R$ 20,00
SELECT public.rpc_add_cash_movement(
  p_session_id  := (SELECT id FROM cash_register_sessions WHERE company_id = (SELECT company_id FROM users WHERE role IN ('admin','gerente') AND company_id IS NOT NULL LIMIT 1) AND status = 'open' LIMIT 1),
  p_user_id     := (SELECT id FROM users WHERE role IN ('admin','gerente') AND company_id IS NOT NULL LIMIT 1),
  p_type        := 'expense',
  p_method      := 'cash',
  p_amount      := 20.00,
  p_description := 'TESTE 6 — despesa de limpeza'
) AS despesa;

-- Verificar movimentos registrados (3 ativos)
SELECT type, method, amount, description
FROM cash_movements
WHERE cash_session_id = (
  SELECT id FROM cash_register_sessions
  WHERE company_id = (SELECT company_id FROM users WHERE role IN ('admin','gerente') AND company_id IS NOT NULL LIMIT 1)
    AND status = 'open' LIMIT 1
)
  AND cancelled_at IS NULL
ORDER BY created_at;
-- Esperado: 3 linhas — suprimento 50, sangria 30, expense 20

-- 5. Fechar caixa com R$ 110,00 contados
SELECT public.rpc_close_cash_session(
  p_session_id   := (SELECT id FROM cash_register_sessions WHERE company_id = (SELECT company_id FROM users WHERE role IN ('admin','gerente') AND company_id IS NOT NULL LIMIT 1) AND status = 'open' LIMIT 1),
  p_user_id      := (SELECT id FROM users WHERE role IN ('admin','gerente') AND company_id IS NOT NULL LIMIT 1),
  p_counted_cash := 110.00,
  p_notes        := 'TESTE 6 — fechamento'
) AS fechamento;

-- Verificar snapshot gravado na sessão
SELECT
  status,
  opening_amount_cash,
  counted_cash,
  total_suprimento,
  total_sangria,
  total_expenses,
  expected_cash,
  cash_difference
FROM cash_register_sessions
WHERE company_id = (SELECT company_id FROM users WHERE role IN ('admin','gerente') AND company_id IS NOT NULL LIMIT 1)
ORDER BY closed_at DESC
LIMIT 1;
-- Esperado:
--   status           = 'closed'
--   opening_amount_cash = 100.00
--   counted_cash        = 110.00
--   total_suprimento    = 50.00
--   total_sangria       = 30.00
--   total_expenses      = 20.00
--   expected_cash       = 100.00
--   cash_difference     = +10.00

ROLLBACK;

-- =============================================================================
-- TESTE 7a — Cancelamento lógico de movimento (happy path)
--
-- Sequência:
--   1. Abre caixa
--   2. Registra sangria R$ 40,00
--   3. Cancela o movimento com motivo
--   4. Verifica cancelled_at preenchido e 0 movimentos ativos
-- =============================================================================

BEGIN;

-- 1. Abrir caixa
SELECT public.rpc_open_cash_session(
  p_user_id             := (SELECT id FROM users WHERE role IN ('admin','gerente') AND company_id IS NOT NULL LIMIT 1),
  p_opening_amount_cash := 0,
  p_notes               := 'TESTE 7a — cancela movimento'
);

-- 2. Registrar sangria
SELECT public.rpc_add_cash_movement(
  p_session_id  := (SELECT id FROM cash_register_sessions WHERE company_id = (SELECT company_id FROM users WHERE role IN ('admin','gerente') AND company_id IS NOT NULL LIMIT 1) AND status = 'open' LIMIT 1),
  p_user_id     := (SELECT id FROM users WHERE role IN ('admin','gerente') AND company_id IS NOT NULL LIMIT 1),
  p_type        := 'sangria',
  p_amount      := 40.00,
  p_description := 'TESTE 7a — sangria a cancelar'
) AS sangria;

-- 3. Cancelar o movimento
SELECT public.rpc_cancel_cash_movement(
  p_movement_id         := (SELECT id FROM cash_movements WHERE cash_session_id = (SELECT id FROM cash_register_sessions WHERE company_id = (SELECT company_id FROM users WHERE role IN ('admin','gerente') AND company_id IS NOT NULL LIMIT 1) AND status = 'open' LIMIT 1) ORDER BY created_at DESC LIMIT 1),
  p_user_id             := (SELECT id FROM users WHERE role IN ('admin','gerente') AND company_id IS NOT NULL LIMIT 1),
  p_cancellation_reason := 'TESTE 7a — sangria registrada por engano'
) AS cancelamento;

-- 4a. Verificar soft delete
SELECT
  id,
  type,
  amount,
  cancelled_at IS NOT NULL AS foi_cancelado,
  cancellation_reason
FROM cash_movements
WHERE cash_session_id = (
  SELECT id FROM cash_register_sessions
  WHERE company_id = (SELECT company_id FROM users WHERE role IN ('admin','gerente') AND company_id IS NOT NULL LIMIT 1)
    AND status = 'open' LIMIT 1
)
ORDER BY created_at DESC LIMIT 1;
-- Esperado: foi_cancelado=TRUE, cancellation_reason='TESTE 7a — sangria registrada por engano'

-- 4b. Nenhum movimento ativo deve restar
SELECT COUNT(*) AS ativos
FROM cash_movements
WHERE cash_session_id = (
  SELECT id FROM cash_register_sessions
  WHERE company_id = (SELECT company_id FROM users WHERE role IN ('admin','gerente') AND company_id IS NOT NULL LIMIT 1)
    AND status = 'open' LIMIT 1
)
  AND cancelled_at IS NULL;
-- Esperado: 0

ROLLBACK;

-- =============================================================================
-- TESTE 7b — Rejeitar duplo cancelamento
--
-- Bloco separado do 7a: o erro esperado no final abortaria a transação
-- inteira se estivesse junto com as verificações acima.
-- Esperado: "ERROR: Movimento #X já foi cancelado."
-- =============================================================================

BEGIN;

SELECT public.rpc_open_cash_session(
  p_user_id             := (SELECT id FROM users WHERE role IN ('admin','gerente') AND company_id IS NOT NULL LIMIT 1),
  p_opening_amount_cash := 0,
  p_notes               := 'TESTE 7b — duplo cancelamento'
);

SELECT public.rpc_add_cash_movement(
  p_session_id  := (SELECT id FROM cash_register_sessions WHERE company_id = (SELECT company_id FROM users WHERE role IN ('admin','gerente') AND company_id IS NOT NULL LIMIT 1) AND status = 'open' LIMIT 1),
  p_user_id     := (SELECT id FROM users WHERE role IN ('admin','gerente') AND company_id IS NOT NULL LIMIT 1),
  p_type        := 'sangria',
  p_amount      := 40.00,
  p_description := 'TESTE 7b — sangria para duplo cancelamento'
);

-- Primeiro cancelamento (deve funcionar)
SELECT public.rpc_cancel_cash_movement(
  p_movement_id         := (SELECT id FROM cash_movements WHERE cash_session_id = (SELECT id FROM cash_register_sessions WHERE company_id = (SELECT company_id FROM users WHERE role IN ('admin','gerente') AND company_id IS NOT NULL LIMIT 1) AND status = 'open' LIMIT 1) ORDER BY created_at DESC LIMIT 1),
  p_user_id             := (SELECT id FROM users WHERE role IN ('admin','gerente') AND company_id IS NOT NULL LIMIT 1),
  p_cancellation_reason := 'TESTE 7b — primeiro cancelamento'
);

-- Segundo cancelamento (DEVE LANÇAR EXCEÇÃO — aborta o bloco)
SELECT public.rpc_cancel_cash_movement(
  p_movement_id         := (SELECT id FROM cash_movements WHERE cash_session_id = (SELECT id FROM cash_register_sessions WHERE company_id = (SELECT company_id FROM users WHERE role IN ('admin','gerente') AND company_id IS NOT NULL LIMIT 1) AND status = 'open' LIMIT 1) ORDER BY created_at DESC LIMIT 1),
  p_user_id             := (SELECT id FROM users WHERE role IN ('admin','gerente') AND company_id IS NOT NULL LIMIT 1),
  p_cancellation_reason := 'TESTE 7b — segundo cancelamento (deve falhar)'
);
-- Esperado: "ERROR: Movimento #X já foi cancelado."
-- A exceção acima aborta a transação. O ROLLBACK abaixo fecha o bloco
-- sintaticamente e confirma o rollback da transação abortada.

ROLLBACK;

-- =============================================================================
-- TESTE 8 — Bloqueio de operações em caixa fechado
--
-- Valida que:
--   a) rpc_add_cash_movement rejeita após fechamento
--   b) rpc_close_cash_session rejeita duplo fechamento
--   c) rpc_cancel_cash_movement rejeita após fechamento
-- =============================================================================

BEGIN;

-- Abrir e fechar o caixa rapidamente
SELECT public.rpc_open_cash_session(
  p_user_id             := (SELECT id FROM users WHERE role IN ('admin','gerente') AND company_id IS NOT NULL LIMIT 1),
  p_opening_amount_cash := 0,
  p_notes               := 'TESTE 8 — vai fechar imediatamente'
);

-- Adicionar um movimento antes de fechar (para usar no sub-teste c)
SELECT public.rpc_add_cash_movement(
  p_session_id  := (SELECT id FROM cash_register_sessions WHERE company_id = (SELECT company_id FROM users WHERE role IN ('admin','gerente') AND company_id IS NOT NULL LIMIT 1) AND status = 'open' LIMIT 1),
  p_user_id     := (SELECT id FROM users WHERE role IN ('admin','gerente') AND company_id IS NOT NULL LIMIT 1),
  p_type        := 'expense',
  p_method      := 'cash',
  p_amount      := 10.00,
  p_description := 'TESTE 8 — movimento pré-fechamento'
);

SELECT public.rpc_close_cash_session(
  p_session_id   := (SELECT id FROM cash_register_sessions WHERE company_id = (SELECT company_id FROM users WHERE role IN ('admin','gerente') AND company_id IS NOT NULL LIMIT 1) AND status = 'open' LIMIT 1),
  p_user_id      := (SELECT id FROM users WHERE role IN ('admin','gerente') AND company_id IS NOT NULL LIMIT 1),
  p_counted_cash := 0,
  p_notes        := 'TESTE 8 — fechamento'
);

-- a) Tentar adicionar movimento em caixa fechado (DEVE LANÇAR EXCEÇÃO)
SELECT public.rpc_add_cash_movement(
  p_session_id  := (SELECT id FROM cash_register_sessions WHERE company_id = (SELECT company_id FROM users WHERE role IN ('admin','gerente') AND company_id IS NOT NULL LIMIT 1) ORDER BY closed_at DESC LIMIT 1),
  p_user_id     := (SELECT id FROM users WHERE role IN ('admin','gerente') AND company_id IS NOT NULL LIMIT 1),
  p_type        := 'sangria',
  p_method      := 'cash',
  p_amount      := 5.00,
  p_description := 'TESTE 8a — deve falhar'
) AS bloco_a;
-- Esperado: "ERROR: Caixa fechado. Não é possível registrar movimentos."

ROLLBACK;

BEGIN;
-- (Recria o cenário de caixa fechado para os sub-testes b e c)

SELECT public.rpc_open_cash_session(
  p_user_id             := (SELECT id FROM users WHERE role IN ('admin','gerente') AND company_id IS NOT NULL LIMIT 1),
  p_opening_amount_cash := 0
);

SELECT public.rpc_add_cash_movement(
  p_session_id  := (SELECT id FROM cash_register_sessions WHERE company_id = (SELECT company_id FROM users WHERE role IN ('admin','gerente') AND company_id IS NOT NULL LIMIT 1) AND status = 'open' LIMIT 1),
  p_user_id     := (SELECT id FROM users WHERE role IN ('admin','gerente') AND company_id IS NOT NULL LIMIT 1),
  p_type        := 'expense',
  p_method      := 'cash',
  p_amount      := 10.00,
  p_description := 'TESTE 8bc — movimento pré-fechamento'
);

SELECT public.rpc_close_cash_session(
  p_session_id   := (SELECT id FROM cash_register_sessions WHERE company_id = (SELECT company_id FROM users WHERE role IN ('admin','gerente') AND company_id IS NOT NULL LIMIT 1) AND status = 'open' LIMIT 1),
  p_user_id      := (SELECT id FROM users WHERE role IN ('admin','gerente') AND company_id IS NOT NULL LIMIT 1),
  p_counted_cash := 0
);

-- b) Tentar fechar o mesmo caixa duas vezes (DEVE LANÇAR EXCEÇÃO)
SELECT public.rpc_close_cash_session(
  p_session_id   := (SELECT id FROM cash_register_sessions WHERE company_id = (SELECT company_id FROM users WHERE role IN ('admin','gerente') AND company_id IS NOT NULL LIMIT 1) ORDER BY closed_at DESC LIMIT 1),
  p_user_id      := (SELECT id FROM users WHERE role IN ('admin','gerente') AND company_id IS NOT NULL LIMIT 1),
  p_counted_cash := 0
) AS bloco_b;
-- Esperado: "ERROR: Caixa já fechado."

ROLLBACK;

BEGIN;
-- (Sub-teste c: cancelar movimento de caixa já fechado)

SELECT public.rpc_open_cash_session(
  p_user_id             := (SELECT id FROM users WHERE role IN ('admin','gerente') AND company_id IS NOT NULL LIMIT 1),
  p_opening_amount_cash := 0
);

SELECT public.rpc_add_cash_movement(
  p_session_id  := (SELECT id FROM cash_register_sessions WHERE company_id = (SELECT company_id FROM users WHERE role IN ('admin','gerente') AND company_id IS NOT NULL LIMIT 1) AND status = 'open' LIMIT 1),
  p_user_id     := (SELECT id FROM users WHERE role IN ('admin','gerente') AND company_id IS NOT NULL LIMIT 1),
  p_type        := 'expense',
  p_method      := 'cash',
  p_amount      := 15.00,
  p_description := 'TESTE 8c — movimento a cancelar depois do fechamento'
);

SELECT public.rpc_close_cash_session(
  p_session_id   := (SELECT id FROM cash_register_sessions WHERE company_id = (SELECT company_id FROM users WHERE role IN ('admin','gerente') AND company_id IS NOT NULL LIMIT 1) AND status = 'open' LIMIT 1),
  p_user_id      := (SELECT id FROM users WHERE role IN ('admin','gerente') AND company_id IS NOT NULL LIMIT 1),
  p_counted_cash := 0
);

-- c) Tentar cancelar movimento de sessão fechada (DEVE LANÇAR EXCEÇÃO)
SELECT public.rpc_cancel_cash_movement(
  p_movement_id         := (SELECT cm.id FROM cash_movements cm JOIN cash_register_sessions crs ON crs.id = cm.cash_session_id WHERE crs.company_id = (SELECT company_id FROM users WHERE role IN ('admin','gerente') AND company_id IS NOT NULL LIMIT 1) ORDER BY cm.created_at DESC LIMIT 1),
  p_user_id             := (SELECT id FROM users WHERE role IN ('admin','gerente') AND company_id IS NOT NULL LIMIT 1),
  p_cancellation_reason := 'TESTE 8c — deve falhar'
) AS bloco_c;
-- Esperado: "ERROR: Caixa fechado. Não é possível cancelar movimentos."

ROLLBACK;

-- =============================================================================
-- TESTE 9 — Constraint: sangria com method != 'cash' (deve rejeitar)
-- =============================================================================

BEGIN;

SELECT public.rpc_open_cash_session(
  p_user_id             := (SELECT id FROM users WHERE role IN ('admin','gerente') AND company_id IS NOT NULL LIMIT 1),
  p_opening_amount_cash := 0
);

-- Sangria com method='pix' — DEVE LANÇAR EXCEÇÃO (P0001 na validação do RPC)
SELECT public.rpc_add_cash_movement(
  p_session_id  := (SELECT id FROM cash_register_sessions WHERE company_id = (SELECT company_id FROM users WHERE role IN ('admin','gerente') AND company_id IS NOT NULL LIMIT 1) AND status = 'open' LIMIT 1),
  p_user_id     := (SELECT id FROM users WHERE role IN ('admin','gerente') AND company_id IS NOT NULL LIMIT 1),
  p_type        := 'sangria',
  p_method      := 'pix',
  p_amount      := 50.00,
  p_description := 'TESTE 9 — sangria via pix (deve falhar)'
);
-- Esperado: "ERROR: Sangria e suprimento são sempre em dinheiro físico. Método recebido: pix"

ROLLBACK;

-- =============================================================================
-- TESTE 10 — rpc_create_sale vincula cash_session_id
-- Esperado: venda criada com cash_session_id preenchido
-- =============================================================================

BEGIN;

-- Abrir caixa
SELECT public.rpc_open_cash_session(
  p_user_id             := (SELECT id FROM users WHERE role IN ('admin','gerente') AND company_id IS NOT NULL LIMIT 1),
  p_opening_amount_cash := 0,
  p_notes               := 'TESTE 10 — venda vinculada'
);

-- Criar venda via rpc_create_sale com p_cash_session_id
SELECT public.rpc_create_sale(
  p_customer_id      := (SELECT c.id FROM customers c JOIN users u ON u.company_id = c.company_id WHERE u.role IN ('admin','gerente') LIMIT 1),
  p_seller_id        := (SELECT id FROM users WHERE role IN ('admin','gerente') AND company_id IS NOT NULL LIMIT 1),
  p_payment_method   := 'cash'::payment_method,
  p_sale_origin      := NULL,
  p_discount_amount  := 0,
  p_cashback_used    := 0,
  p_shipping_charged := 0,
  p_notes            := 'TESTE 10 — venda de caixa',
  p_items            := (
    SELECT jsonb_build_array(jsonb_build_object(
      'product_variation_id', pv.id,
      'quantity', 1,
      'unit_price', 50.00,
      'unit_cost', s.avg_cost,
      'discount_amount', 0
    ))
    FROM stock s
    JOIN product_variations pv ON pv.id = s.product_variation_id
    JOIN products p ON p.id = pv.product_id
    JOIN users u ON u.company_id = p.company_id
    WHERE u.role IN ('admin','gerente') AND s.quantity > 0
    LIMIT 1
  ),
  p_system_user_id   := (SELECT id FROM users WHERE role IN ('admin','gerente') AND company_id IS NOT NULL LIMIT 1),
  p_card_fee         := 0,
  p_surcharge_amount := 0,
  p_payments         := jsonb_build_array(jsonb_build_object(
    'method',          'cash',
    'amount_tendered', 60.00,
    'change_amount',   10.00,
    'change_method',   'cash',
    'net_amount',      50.00
  )),
  p_cash_session_id  := (
    SELECT id FROM cash_register_sessions
    WHERE company_id = (SELECT company_id FROM users WHERE role IN ('admin','gerente') AND company_id IS NOT NULL LIMIT 1)
      AND status = 'open'
    LIMIT 1
  )
) AS venda;

-- Verificar cash_session_id preenchido na venda
SELECT
  id,
  sale_number,
  cash_session_id IS NOT NULL AS tem_sessao
FROM sales
ORDER BY created_at DESC
LIMIT 1;
-- Esperado: tem_sessao = TRUE

ROLLBACK;

-- =============================================================================
-- FIM DA VALIDAÇÃO — Módulo de Caixa (20260522)
-- Todos os ROLLBACK acima: nenhum dado foi persistido no banco.
-- =============================================================================
