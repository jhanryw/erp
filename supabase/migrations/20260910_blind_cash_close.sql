-- =============================================================================
-- Migration 20260910 — Fechamento de caixa: conferência cega real
--
-- CONTEXTO (auditoria solicitada em 2026-09-10):
--   O fechamento de caixa não exige senha de administrador (nunca exigiu, no
--   código de `main` — nenhuma migration ou rota jamais implementou isso).
--   O problema real e comprovado era outro: `expected_cash`/`cash_difference`
--   eram calculados e DEVOLVIDOS ao chamador (preview, resposta de sucesso,
--   histórico) e ainda eram legíveis por leitura direta autenticada da
--   tabela (RLS por company_id, sem distinção de role de aplicação). Além
--   disso, desde 20260611_fix_caixa_close.sql, o fechamento NUNCA bloqueava
--   por divergência — fechava sempre, só registrando a diferença.
--
-- O QUE ESTA MIGRATION MUDA:
--   1. rpc_close_cash_session: agora é a fonte de verdade da comparação.
--      - Se counted_cash (normalizado em centavos, NUMERIC) == expected_cash
--        calculado internamente → fecha, persiste tudo, retorna status='closed'
--        com os dados contábeis completos (a filtragem por role acontece na
--        camada de API, não aqui — ver src/app/api/caixa/fechar/route.ts).
--      - Se diferente → NÃO fecha (nenhum UPDATE roda, closed_at/status
--        permanecem intactos) e retorna só {status:'mismatch', id}, sem
--        nenhum valor numérico.
--      - Fórmula financeira preservada exatamente igual a
--        20260611_fix_caixa_close.sql — nenhuma mudança de cálculo.
--      - Lock pessimista (FOR UPDATE) já existente é o que garante
--        atomicidade: duas chamadas concorrentes pra mesma sessão serializam
--        no lock da linha; a segunda só prossegue depois que a primeira
--        commita (fechando ou não), e então vê o status já atualizado.
--   2. Vazamento estrutural via Supabase REST/JS client: revoga o SELECT
--      direto de `authenticated`/`anon`/PUBLIC na tabela
--      `cash_register_sessions` e substitui por uma VIEW
--      (`cash_register_sessions_secure`) que:
--        - filtra por tenant explicitamente (não depende de RLS da tabela
--          base, que deixa de ser alcançável por `authenticated` de qualquer
--          forma);
--        - mascara (retorna NULL) `expected_cash`/`cash_difference` quando
--          `public.get_user_role()` (função já existente, usada em RLS por
--          todo o projeto) não é 'gerente'/'admin'.
--      `service_role` (usado por toda a Next.js API via createAdminClient())
--      não é afetado — nunca dependeu do GRANT de `authenticated`.
--   3. EXECUTE em rpc_close_cash_session: 20260811_fix_rpc_identity_grants_
--      tenant.sql revogou só de `authenticated` — nunca de `PUBLIC`. Como
--      20260828_rpc_create_sale_pricing_and_products_total.sql confirmou AO
--      VIVO (pra rpc_create_sale) que funções deste projeto recebem GRANT
--      EXECUTE explícito pra PUBLIC/anon/authenticated na criação, e listou
--      esta RPC como candidata não confirmada ao mesmo problema, esta
--      migration REVOGA explicitamente de PUBLIC/anon/authenticated e
--      GRANTa de novo só pra service_role — fechando a lacuna
--      independentemente de qual seja o estado real herdado.
--
-- NÃO MEXE EM:
--   - Nenhuma migration histórica é editada (20260522/20260611/20260812
--     continuam como estavam — este arquivo é aditivo).
--   - As outras 10 RPCs listadas em 20260828 com o mesmo risco não
--     confirmado (rpc_cancel_sale, rpc_return_sale, rpc_process_exchange,
--     rpc_open_cash_session, rpc_add_cash_movement, rpc_cancel_cash_movement,
--     rpc_reopen_cash_session, rpc_stock_entry, rpc_stock_adjust,
--     rpc_pagar_repasse_lote) — fora de escopo desta correção, que trata
--     apenas da função que esta migration já está reescrevendo.
--
-- IDEMPOTENTE: sim (CREATE OR REPLACE, DROP VIEW IF EXISTS, REVOKE é no-op
-- se já revogado).
-- =============================================================================


-- =============================================================================
-- PARTE 1 — rpc_close_cash_session: comparação autoritativa + não-fechamento
--            em divergência
-- =============================================================================

CREATE OR REPLACE FUNCTION public.rpc_close_cash_session(
  p_session_id    bigint,
  p_user_id       uuid,
  p_counted_cash  numeric,
  p_notes         text     DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_company_id        int;
  v_sess              record;

  v_total_sales       numeric := 0;
  v_total_cash        numeric := 0;
  v_total_pix         numeric := 0;
  v_total_credit      numeric := 0;
  v_total_debit       numeric := 0;
  v_total_card_fees   numeric := 0;
  v_total_cash_change numeric := 0;
  v_total_pix_change  numeric := 0;

  v_cash_tendered     numeric := 0;
  v_expense_cash      numeric := 0;

  v_total_sangria     numeric := 0;
  v_total_suprimento  numeric := 0;
  v_total_expenses    numeric := 0;

  v_expected_cash     numeric;
  v_counted_cash      numeric;
  v_cash_difference   numeric;
BEGIN
  SELECT company_id INTO v_company_id FROM users WHERE id = p_user_id;
  IF v_company_id IS NULL THEN
    RAISE EXCEPTION 'Usuário não associado a uma empresa.' USING ERRCODE = 'P0001';
  END IF;

  -- Lock pessimista: mantém a linha travada até o fim da transação desta
  -- chamada (fechando ou não). Uma segunda chamada concorrente pro mesmo
  -- p_session_id bloqueia aqui até esta transação commitar, e então lê o
  -- status já atualizado — impede fechamento duplo e qualquer condição de
  -- corrida entre duas tentativas simultâneas de fechamento.
  SELECT * INTO v_sess
  FROM cash_register_sessions
  WHERE id = p_session_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Sessão de caixa #% não encontrada.', p_session_id USING ERRCODE = 'P0001';
  END IF;
  IF v_sess.company_id != v_company_id THEN
    RAISE EXCEPTION 'Acesso negado à sessão de caixa.' USING ERRCODE = 'P0001';
  END IF;
  IF v_sess.status = 'closed' THEN
    RAISE EXCEPTION 'Caixa já fechado.' USING ERRCODE = 'P0001';
  END IF;
  IF COALESCE(p_counted_cash, -1) < 0 THEN
    RAISE EXCEPTION 'Valor contado não pode ser negativo.' USING ERRCODE = 'P0001';
  END IF;

  -- Normaliza pra centavos ANTES de comparar — NUMERIC é decimal exato (sem
  -- artefato de float), então ROUND(x,2) = ROUND(y,2) é uma igualdade
  -- determinística. Sem tolerância arbitrária: a granularidade da moeda
  -- (centavo) já é o próprio critério, e é a mesma precisão das colunas
  -- (NUMERIC(10,2)).
  v_counted_cash := ROUND(p_counted_cash, 2);

  -- Total de vendas (uma linha por venda, sem double-count)
  SELECT COALESCE(SUM(total), 0)
  INTO   v_total_sales
  FROM   sales
  WHERE  cash_session_id = p_session_id
    AND  status NOT IN ('cancelled', 'returned');

  -- Totais por método de pagamento
  SELECT
    COALESCE(SUM(sp.net_amount) FILTER (WHERE sp.method = 'pix'),         0),
    COALESCE(SUM(sp.net_amount) FILTER (WHERE sp.method = 'cash'),        0),
    COALESCE(SUM(sp.net_amount) FILTER (WHERE sp.method = 'credit_card'), 0),
    COALESCE(SUM(sp.net_amount) FILTER (WHERE sp.method = 'debit_card'),  0),
    COALESCE(SUM(sp.fee_amount) FILTER (WHERE sp.method IN ('credit_card','debit_card')), 0),
    COALESCE(SUM(sp.change_amount) FILTER (WHERE sp.method = 'cash' AND sp.change_method = 'cash'), 0),
    COALESCE(SUM(sp.change_amount) FILTER (WHERE sp.method = 'cash' AND sp.change_method = 'pix'),  0),
    -- COALESCE: usa amount_tendered se preenchido, senão net_amount (evita zerado)
    COALESCE(
      SUM(COALESCE(sp.amount_tendered, sp.net_amount)) FILTER (WHERE sp.method = 'cash'),
    0)
  INTO
    v_total_pix,
    v_total_cash,
    v_total_credit,
    v_total_debit,
    v_total_card_fees,
    v_total_cash_change,
    v_total_pix_change,
    v_cash_tendered
  FROM sale_payments sp
  JOIN sales s ON s.id = sp.sale_id
  WHERE s.cash_session_id = p_session_id
    AND s.status NOT IN ('cancelled', 'returned');

  -- Movimentos do caixa (sangria, suprimento, despesa)
  SELECT
    COALESCE(SUM(amount) FILTER (WHERE type = 'sangria'),                     0),
    COALESCE(SUM(amount) FILTER (WHERE type = 'suprimento'),                  0),
    COALESCE(SUM(amount) FILTER (WHERE type = 'expense'),                     0),
    COALESCE(SUM(amount) FILTER (WHERE type = 'expense' AND method = 'cash'), 0)
  INTO
    v_total_sangria,
    v_total_suprimento,
    v_total_expenses,
    v_expense_cash
  FROM cash_movements
  WHERE cash_session_id = p_session_id
    AND cancelled_at IS NULL;

  -- Fórmula preservada exatamente igual a 20260611_fix_caixa_close.sql.
  v_expected_cash := ROUND(
    v_sess.opening_amount_cash
    + v_cash_tendered
    - v_total_cash_change
    + v_total_suprimento
    - v_total_sangria
    - v_expense_cash
  , 2);

  v_cash_difference := v_counted_cash - v_expected_cash;

  -- ─── Divergência: NÃO fecha, NÃO persiste nada, NÃO revela números ───────
  IF v_cash_difference <> 0 THEN
    RETURN jsonb_build_object(
      'status', 'mismatch',
      'id',     p_session_id
    );
  END IF;

  -- ─── Confere: fecha e persiste os dados contábeis completos ──────────────
  UPDATE cash_register_sessions
  SET
    status            = 'closed',
    closed_by         = p_user_id,
    closed_at         = NOW(),
    counted_cash      = v_counted_cash,
    notes_close       = NULLIF(TRIM(COALESCE(p_notes, '')), ''),
    updated_at        = NOW(),
    total_sales       = ROUND(v_total_sales,       2),
    total_cash        = ROUND(v_total_cash,        2),
    total_pix         = ROUND(v_total_pix,         2),
    total_credit_card = ROUND(v_total_credit,      2),
    total_debit_card  = ROUND(v_total_debit,       2),
    total_card_fees   = ROUND(v_total_card_fees,   2),
    total_cash_change = ROUND(v_total_cash_change, 2),
    total_pix_change  = ROUND(v_total_pix_change,  2),
    total_sangria     = ROUND(v_total_sangria,     2),
    total_suprimento  = ROUND(v_total_suprimento,  2),
    total_expenses    = ROUND(v_total_expenses,    2),
    expected_cash     = v_expected_cash,
    cash_difference   = v_cash_difference
  WHERE id = p_session_id;

  RETURN jsonb_build_object(
    'status',           'closed',
    'id',               p_session_id,
    'closed_at',        NOW(),
    'total_sales',      ROUND(v_total_sales,       2),
    'total_cash',       ROUND(v_total_cash,        2),
    'total_pix',        ROUND(v_total_pix,         2),
    'total_credit_card',ROUND(v_total_credit,      2),
    'total_debit_card', ROUND(v_total_debit,       2),
    'total_card_fees',  ROUND(v_total_card_fees,   2),
    'total_cash_change',ROUND(v_total_cash_change, 2),
    'total_pix_change', ROUND(v_total_pix_change,  2),
    'total_sangria',    ROUND(v_total_sangria,     2),
    'total_suprimento', ROUND(v_total_suprimento,  2),
    'total_expenses',   ROUND(v_total_expenses,    2),
    'expected_cash',    v_expected_cash,
    'counted_cash',     v_counted_cash,
    'cash_difference',  v_cash_difference
  );
END;
$$;

COMMENT ON FUNCTION public.rpc_close_cash_session(bigint, uuid, numeric, text) IS
  'Conferência cega: compara counted_cash com expected_cash internamente. '
  'Só persiste o fechamento (status=closed) quando os valores conferem '
  'exatamente (NUMERIC, sem tolerância). Em divergência retorna apenas '
  '{status:''mismatch'', id} sem revelar nenhum valor — a sessão continua '
  'aberta. GRANT EXECUTE restrito a service_role (ver REVOKE/GRANT '
  'explícitos logo abaixo, que fecham a lacuna de PUBLIC deixada por '
  '20260811).';

-- Achado desta revisão (não presumir que 20260811_fix_rpc_identity_grants_
-- tenant.sql:624 "REVOKE EXECUTE ... FROM authenticated" já bastava):
-- aquela migration revogou só de `authenticated`, nunca de `PUBLIC`. A
-- migration 20260828_rpc_create_sale_pricing_and_products_total.sql
-- (linhas ~104-124) confirmou AO VIVO, para rpc_create_sale, que funções
-- deste projeto recebem GRANT EXECUTE explícito pra PUBLIC/anon/
-- authenticated/service_role na criação (privilégio de projeto Supabase,
-- fora da árvore de migrations) — e listou as outras 10 RPCs tocadas por
-- 20260811, rpc_close_cash_session incluída, como "mesmo problema
-- provável, não confirmado". REVOKE FROM authenticated sozinho não remove
-- um grant de PUBLIC (authenticated herda de PUBLIC independentemente de
-- qualquer REVOKE direcionado só a ele). Mesmo padrão de correção já usado
-- em 202609041300_hardening_fiscal_rpc_grants_revoke_public.sql — aplicado
-- aqui à função que esta migration já está reescrevendo, sem tocar nas
-- outras 10 RPCs (fora de escopo desta correção).
REVOKE ALL ON FUNCTION public.rpc_close_cash_session(bigint, uuid, numeric, text)
  FROM PUBLIC, anon, authenticated;

GRANT EXECUTE ON FUNCTION public.rpc_close_cash_session(bigint, uuid, numeric, text)
  TO service_role;


-- =============================================================================
-- PARTE 2 — Vazamento estrutural: SELECT direto por `authenticated`
--
-- RLS controla LINHAS, não CAMPOS — a policy "cash_sessions_company_read"
-- (20260522_cash_register.sql) libera a linha inteira, `expected_cash` e
-- `cash_difference` incluídos, pra qualquer autenticado da empresa. Como
-- todo mundo (usuario/gerente/admin) autentica sob a MESMA role Postgres
-- `authenticated`, não dá pra diferenciar por role de aplicação com GRANT
-- de coluna nem com uma RLS policy adicional — as duas mecânicas do
-- Postgres não enxergam 'usuario' vs 'gerente', só enxergam a role
-- Postgres e as linhas. A solução é revogar o acesso direto à tabela e
-- expor uma VIEW que decide, campo a campo, usando a hierarquia de
-- aplicação REAL do projeto (public.get_user_role(), já usada em RLS por
-- todo o repo — 20260522_sale_payments_table.sql,
-- 20260820_fix_rls_open_policies_tenant_isolation.sql etc.).
--
-- Nenhum código do projeto depende do GRANT direto de `authenticated`
-- nesta tabela: os 4 pontos de leitura confirmados
-- (src/services/caixa.service.ts, src/app/api/caixa/fechar/route.ts,
-- src/app/(dashboard)/caixa/historico/page.tsx e .../historico/[id]/page.tsx)
-- usam todos createAdminClient() (service_role), que não passa por RLS nem
-- pelos GRANTs de `authenticated` — o REVOKE abaixo não quebra nenhum
-- deles. O único consumidor real do GRANT revogado era a leitura direta via
-- Supabase REST/JS client com a anon key + JWT do próprio usuário logado,
-- que é exatamente o vetor que a auditoria comprovou.
-- =============================================================================

-- FROM PUBLIC, anon, authenticated (não só authenticated): mesma lógica do
-- REVOKE de EXECUTE acima — nunca assumir que revogar de um único role
-- fecha a exposição quando PUBLIC/anon podem ter grant independente.
REVOKE SELECT ON public.cash_register_sessions FROM PUBLIC, anon, authenticated;

DROP VIEW IF EXISTS public.cash_register_sessions_secure;
CREATE VIEW public.cash_register_sessions_secure
WITH (security_barrier = true)
AS
SELECT
  crs.id,
  crs.company_id,
  crs.status,
  crs.opened_by,
  crs.opened_at,
  crs.opening_amount_cash,
  crs.notes_open,
  crs.closed_by,
  crs.closed_at,
  crs.counted_cash,
  crs.notes_close,
  crs.closing_confirmed_by,
  crs.total_sales,
  crs.total_cash,
  crs.total_pix,
  crs.total_credit_card,
  crs.total_debit_card,
  crs.total_card_fees,
  crs.total_cash_change,
  crs.total_pix_change,
  crs.total_sangria,
  crs.total_suprimento,
  crs.total_expenses,
  crs.created_at,
  crs.updated_at,
  -- Mascarado: NULL pra quem não é gerente/admin. `get_user_role()` é
  -- STABLE + SECURITY DEFINER (000_schema_completo.sql / migration 001) —
  -- resolve o role de auth.uid() sem depender de RLS de public.users.
  CASE WHEN public.get_user_role() = ANY (ARRAY['admin','gerente'])
       THEN crs.expected_cash ELSE NULL END AS expected_cash,
  CASE WHEN public.get_user_role() = ANY (ARRAY['admin','gerente'])
       THEN crs.cash_difference ELSE NULL END AS cash_difference
FROM public.cash_register_sessions crs
-- Filtro de tenant explícito: a view roda com os privilégios de quem a
-- criou (dono da tabela), então NÃO passa pela RLS da tabela base — sem
-- este WHERE, a remoção do GRANT direto abriria (em vez de fechar) uma
-- via de leitura cross-tenant. security_barrier=true impede o planner de
-- reordenar predicados de um jeito que vaze linhas antes deste filtro.
WHERE crs.company_id = public.current_company_id();

-- REVOKE explícito de PUBLIC/anon antes do GRANT: views não recebem
-- privilégio de PUBLIC por padrão no Postgres (diferente de funções), mas
-- fica explícito de propósito — a mesma cautela do resto desta migration,
-- e o WHERE current_company_id() já garante 0 linhas pra anon de qualquer
-- forma (auth.uid() nulo pra request não-autenticada).
REVOKE ALL ON public.cash_register_sessions_secure FROM PUBLIC, anon;
GRANT SELECT ON public.cash_register_sessions_secure TO authenticated;

COMMENT ON VIEW public.cash_register_sessions_secure IS
  'Superfície de leitura segura de cash_register_sessions pra clients '
  'autenticados (Supabase REST/JS). expected_cash/cash_difference só '
  'aparecem pra gerente/admin (public.get_user_role()) — NULL pra usuario/ '
  'seller. Escopada por tenant explicitamente (não depende de RLS da '
  'tabela base, que passou a ser inalcançável por authenticated).';

-- Nota: a policy "cash_sessions_company_read" (RLS de linha, por
-- company_id) permanece na tabela base — inofensiva e inalcançável por
-- `authenticated` agora que o GRANT de tabela foi revogado, mas não é
-- removida (não editamos migrations históricas, e mantê-la é defesa em
-- profundidade caso um GRANT direto seja reintroduzido por engano no
-- futuro — a policy voltaria a valer imediatamente, sem mascarar campo,
-- mas ainda isolando por tenant).


-- =============================================================================
-- Smoke test inline (mesmo padrão de 20260522_cash_register.sql)
-- =============================================================================

-- Nem anon nem authenticated (nem PUBLIC, verificado via authenticated e
-- anon — os dois roles "de fora" que herdariam de um GRANT a PUBLIC)
-- conseguem SELECT direto na tabela base
SELECT has_table_privilege('authenticated', 'public.cash_register_sessions', 'SELECT') AS deveria_ser_false;
SELECT has_table_privilege('anon',          'public.cash_register_sessions', 'SELECT') AS deveria_ser_false;

-- authenticated deve conseguir SELECT na view segura; anon não
SELECT has_table_privilege('authenticated', 'public.cash_register_sessions_secure', 'SELECT') AS deveria_ser_true;
SELECT has_table_privilege('anon',          'public.cash_register_sessions_secure', 'SELECT') AS deveria_ser_false;

-- service_role não pode ter sido afetado (usado por toda a API server-side)
SELECT has_table_privilege('service_role', 'public.cash_register_sessions', 'SELECT') AS deveria_ser_true;

-- EXECUTE em rpc_close_cash_session: nem anon, nem authenticated (e por
-- extensão PUBLIC, do qual os dois herdariam) — só service_role. Este
-- smoke test é o que efetivamente FECHA o achado desta revisão (a lacuna
-- de PUBLIC que 20260811 sozinho não fechava — ver comentário acima do
-- REVOKE ALL ... FROM PUBLIC, anon, authenticated).
SELECT has_function_privilege('authenticated', 'public.rpc_close_cash_session(bigint, uuid, numeric, text)', 'EXECUTE') AS deveria_ser_false;
SELECT has_function_privilege('anon',          'public.rpc_close_cash_session(bigint, uuid, numeric, text)', 'EXECUTE') AS deveria_ser_false;
SELECT has_function_privilege('service_role',  'public.rpc_close_cash_session(bigint, uuid, numeric, text)', 'EXECUTE') AS deveria_ser_true;

-- =============================================================================
-- ROLLBACK
-- =============================================================================
/*
DROP VIEW IF EXISTS public.cash_register_sessions_secure;
GRANT SELECT ON public.cash_register_sessions TO authenticated;
-- rpc_close_cash_session: o REVOKE ALL FROM PUBLIC/anon/authenticated e o
-- GRANT a service_role feitos nesta migration são estado desejado
-- permanente (fecham uma lacuna pré-existente) — não fazem parte do que
-- este rollback deveria desfazer. Reverter só a lógica de comparação:
-- reaplicar o CREATE OR REPLACE FUNCTION de
-- supabase/migrations/20260611_fix_caixa_close.sql (o rollback do grant,
-- se algum dia necessário, é GRANT EXECUTE ... TO service_role,
-- authenticated — mas isso reabriria a lacuna, não recomendado).
*/
-- =============================================================================
-- FIM DA MIGRATION 20260910
-- =============================================================================
