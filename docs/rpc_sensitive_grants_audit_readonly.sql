-- =============================================================================
-- rpc_sensitive_grants_audit_readonly.sql
--
-- SOMENTE LEITURA. Nenhum GRANT/REVOKE/ALTER é executado por este arquivo.
--
-- Rode este script DUAS vezes:
--   1. ANTES de aplicar supabase/migrations/20260829_harden_sensitive_
--      rpc_grants.sql — captura o estado real atual (a evidência que você
--      já trouxe para rpc_create_sale mostrou grants explícitos além do
--      esperado; isto confirma se o mesmo vale para as outras 12).
--   2. DEPOIS de aplicar — confirma que só `service_role` (e,
--      deliberadamente, `authenticated` só em rpc_regularizar_despesa_
--      caixa) tem EXECUTE, e que a assinatura legada de 5 parâmetros de
--      rpc_stock_adjust não tem EXECUTE para ninguém.
--
-- Guarde a saída dos dois runs (cole em texto/CSV) — é a prova real de
-- antes/depois, não uma suposição.
--
-- COMO RODAR:
--   psql "$DATABASE_URL" -f docs/rpc_sensitive_grants_audit_readonly.sql
-- =============================================================================

-- ─── Bloco 1 — quantas assinaturas cada função tem HOJE (detecta overload) ──
SELECT
  p.proname AS funcao,
  COUNT(*) AS quantidade_assinaturas,
  string_agg(pg_get_function_identity_arguments(p.oid), ' | ' ORDER BY pg_get_function_identity_arguments(p.oid)) AS assinaturas
FROM pg_proc p
JOIN pg_namespace n ON n.oid = p.pronamespace
WHERE n.nspname = 'public'
  AND p.proname IN (
    'rpc_cancel_sale', 'rpc_return_sale', 'rpc_process_exchange',
    'rpc_open_cash_session', 'rpc_close_cash_session', 'rpc_reopen_cash_session',
    'rpc_add_cash_movement', 'rpc_cancel_cash_movement',
    'rpc_stock_entry', 'rpc_stock_adjust', 'rpc_pagar_repasse_lote',
    'rpc_regularizar_despesa_caixa'
  )
GROUP BY p.proname
ORDER BY p.proname;
-- Esperado: 1 linha por função, quantidade_assinaturas = 1, EXCETO
-- rpc_stock_adjust, que hoje (ANTES do patch) deve mostrar 2 assinaturas
-- (a de 6 parâmetros vigente + a legada de 5) — e, DEPOIS do patch,
-- continua mostrando as 2 (o Passo 3 da migration revoga EXECUTE da
-- legada, mas não a remove do catálogo — isso exigiria DROP FUNCTION,
-- fora do escopo desta migration só-de-grants).

-- ─── Bloco 2 — matriz completa de GRANTs reais (raw ACL, todo grantee) ─────
-- Não depende de adivinhar quais papéis checar — lista TODOS os grants
-- reais gravados no catálogo, incluindo qualquer role que este script não
-- pensou em checar explicitamente no Bloco 3.
SELECT
  p.proname AS funcao,
  pg_get_function_identity_arguments(p.oid) AS assinatura,
  COALESCE(r.rolname, 'PUBLIC') AS grantee,
  acl.privilege_type
FROM pg_proc p
JOIN pg_namespace n ON n.oid = p.pronamespace
CROSS JOIN LATERAL aclexplode(COALESCE(p.proacl, acldefault('f', p.proowner))) AS acl
LEFT JOIN pg_roles r ON r.oid = acl.grantee
WHERE n.nspname = 'public'
  AND p.proname IN (
    'rpc_cancel_sale', 'rpc_return_sale', 'rpc_process_exchange',
    'rpc_open_cash_session', 'rpc_close_cash_session', 'rpc_reopen_cash_session',
    'rpc_add_cash_movement', 'rpc_cancel_cash_movement',
    'rpc_stock_entry', 'rpc_stock_adjust', 'rpc_pagar_repasse_lote',
    'rpc_regularizar_despesa_caixa'
  )
  AND acl.privilege_type = 'EXECUTE'
ORDER BY p.proname, assinatura, grantee;
-- Esta é a query mais importante — mostra EXATAMENTE quem tem EXECUTE em
-- cada assinatura, sem depender de adivinhar papéis. Se aparecer qualquer
-- grantee inesperado (além de service_role, e authenticated só em
-- rpc_regularizar_despesa_caixa), investigue antes de seguir.

-- ─── Bloco 3 — matriz por papel conhecido (has_function_privilege) ─────────
-- Checagem direta e inequívoca dos 4 papéis relevantes, função a função —
-- funciona independente de quem está conectado rodando o script (não
-- depende de information_schema.routine_privileges, que só mostra linhas
-- visíveis ao role atual).
WITH funcoes(assinatura) AS (
  VALUES
    ('public.rpc_cancel_sale(int, uuid)'),
    ('public.rpc_return_sale(int, uuid)'),
    ('public.rpc_process_exchange(int, int, int, jsonb, text, uuid)'),
    ('public.rpc_open_cash_session(uuid, numeric, text)'),
    ('public.rpc_close_cash_session(bigint, uuid, numeric, text)'),
    ('public.rpc_reopen_cash_session(bigint, uuid, text)'),
    ('public.rpc_add_cash_movement(bigint, uuid, text, numeric, text, text, bigint, jsonb)'),
    ('public.rpc_cancel_cash_movement(bigint, uuid, text)'),
    ('public.rpc_stock_entry(int, int, text, int, numeric, numeric, numeric, date, text, uuid, int)'),
    ('public.rpc_stock_adjust(int, int, text, text, uuid, int)'),
    ('public.rpc_stock_adjust(int, int, text, text, uuid)'),  -- legado, 5 parâmetros
    ('public.rpc_pagar_repasse_lote(int[], uuid, boolean)'),
    ('public.rpc_regularizar_despesa_caixa(bigint, int, finance_category, date, text)')
),
papeis(role) AS (
  VALUES ('public'), ('anon'), ('authenticated'), ('service_role')
)
SELECT
  f.assinatura,
  p.role,
  has_function_privilege(p.role, f.assinatura, 'EXECUTE') AS tem_execute
FROM funcoes f
CROSS JOIN papeis p
ORDER BY f.assinatura, p.role;
-- Esperado DEPOIS do patch: tem_execute = true SOMENTE para
-- (qualquer assinatura, service_role), MAIS
-- (rpc_regularizar_despesa_caixa, authenticated).
-- Tudo mais deve ser false — inclusive as duas linhas de
-- rpc_stock_adjust(...,5 params) para TODOS os papéis (revogado de todos
-- no Passo 3, inclusive service_role).
-- Se a assinatura de 5 parâmetros não existir mais no banco (já foi
-- limpa antes), has_function_privilege lança erro "function ... does not
-- exist" para essa linha — nesse caso, comente essa linha da CTE e rode
-- de novo; é um resultado BOM (a função legada já não existe).
