-- =============================================================================
-- 20260811_enable_rls_users_same_company.sql
--
-- Auditoria de acesso da role `usuario` (seller) — correção de Prioridade 5:
-- public.users nunca teve RLS habilitado em nenhuma migration ativa.
--
-- ANÁLISE DE IMPACTO (feita antes de aplicar, conforme pedido):
--
--   1. Toda leitura/escrita de public.users no código da aplicação usa
--      createAdminClient() (service_role) — NUNCA o client de sessão
--      (createClient(), que respeita RLS). Confirmado por
--      `grep -rn ".from('users')" src` (8 ocorrências, todas em `admin.` /
--      `createAdminClient()`): src/lib/auth/getProfile.ts,
--      src/services/caixa.service.ts,
--      src/services/crm/conversation-notes.service.ts,
--      src/app/api/webhooks/nuvemshop/order/route.ts,
--      src/app/(dashboard)/configuracoes/usuarios/page.tsx,
--      src/app/(dashboard)/configuracoes/colecoes/page.tsx,
--      src/app/(dashboard)/vendas/[id]/page.tsx.
--      service_role SEMPRE bypassa RLS — nenhuma dessas chamadas é afetada
--      por esta migration, em nenhum cenário.
--
--   2. Autenticação (login) usa auth.users (schema interno do Supabase Auth),
--      NUNCA public.users — supabase.auth.getUser()/signInWithPassword() no
--      middleware e em requireSession() não tocam esta tabela. Login/sessão
--      não pode quebrar por esta migration.
--
--   3. As funções auxiliares que TODA policy de RLS do projeto usa —
--      public.current_company_id() e public.get_user_role() — já são
--      SECURITY DEFINER (definidas em 000_schema_completo.sql / migrations
--      anteriores) e leem public.users internamente. Funções SECURITY
--      DEFINER rodam com o privilégio do dono (não do caller) e por padrão
--      NÃO estão sujeitas a RLS na própria tabela que consultam — não há
--      recursão nem risco de a própria função de apoio ficar bloqueada pela
--      policy que ela mesma viabiliza. Esse é o mesmo padrão já usado com
--      segurança em todas as outras tabelas multi-tenant do projeto.
--
--   4. Scripts de teste em supabase/tests/*.sql rodam via conexão direta
--      (superuser/dono da tabela via $DATABASE_URL), que também bypassa RLS
--      por padrão — não afetados.
--
--   5. Nenhuma trigger ou função não-SECURITY-DEFINER lê public.users.
--
-- RISCO RESIDUAL (não eliminável por análise estática, por isso listado):
--   Se o Supabase (schema padrão) concede SELECT/INSERT/UPDATE/DELETE em
--   public.users para os roles `anon`/`authenticated` a nível de tabela
--   (comportamento padrão do template Supabase), qualquer usuário logado
--   podia, até esta migration, consultar a tabela inteira via PostgREST
--   (supabase-js do navegador, painel, Postman com anon/authenticated key)
--   e enumerar nome, role e company_id de TODOS os usuários de TODAS as
--   empresas — inclusive credencial para o achado da migration
--   20260811_fix_rpc_identity_grants_tenant.sql (RPCs que confiam em UUID
--   de parâmetro; a tabela users sem RLS facilitava descobrir o UUID de um
--   gerente/admin). Esta migration fecha exatamente esse vetor, sem tocar
--   em GRANT (que já é o padrão do restante do projeto — RLS restringe
--   linhas, GRANT de tabela permanece como está).
--
-- ESCOPO DESTA CORREÇÃO: apenas SELECT, escopado à própria empresa —
-- mesmo padrão de customers_select/products_select/etc. NÃO adiciona
-- policy de INSERT/UPDATE/DELETE para `authenticated` (permanece
-- bloqueado, já que nenhuma escrita legítima passa por RLS hoje — só
-- service_role escreve em users).
-- =============================================================================

ALTER TABLE public.users ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "users_select_same_company" ON public.users;
CREATE POLICY "users_select_same_company" ON public.users FOR SELECT TO authenticated
  USING (company_id = public.current_company_id());

-- Sem policy de INSERT/UPDATE/DELETE para `authenticated` = permanece
-- bloqueado (mesmo padrão de cash_register_sessions, audit_logs, etc.).
-- Toda escrita legítima em users continua via service_role (admin client),
-- que bypassa RLS e não é afetado por esta migration.

-- =============================================================================
-- ROLLBACK
-- =============================================================================
/*
DROP POLICY IF EXISTS "users_select_same_company" ON public.users;
ALTER TABLE public.users DISABLE ROW LEVEL SECURITY;
*/
-- =============================================================================
-- FIM DA MIGRATION 20260811 (Prioridade 5)
-- =============================================================================
