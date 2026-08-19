-- =============================================================================
-- 20260820_fix_rls_open_policies_tenant_isolation.sql
--
-- Fase 0 fiscal — correção de RLS. Auditoria live (pg_policies, executada
-- manualmente pelo usuário e colada nesta sessão) confirmou que
-- `authenticated_full_access` (ALL, USING true, WITH CHECK true, role
-- authenticated) existe HOJE em: cashback_transactions, customers,
-- finance_entries, product_variations, products, sale_items, sales, users.
-- Além disso, policies "próprias" adicionais também usam `true` sem filtro
-- de empresa: customers_select/customers_insert/customers_update,
-- products_select, product_variations_select, sales_select/sales_insert,
-- sale_items_select/sale_items_insert, finance_entries_select (esta última
-- tem checagem de role, mas nenhuma de company_id).
--
-- NÃO CONFIRMADO / NÃO CORRIGIDO POR ESTA MIGRATION: sale_payments,
-- stock_balances, stock_movements já foram confirmados sem
-- authenticated_full_access e com policy própria corretamente escopada —
-- fora do escopo desta migration, propositalmente.
--
-- AUDITORIA DIRIGIDA (feita antes de escrever esta migration, não
-- presumida) — para cada uma das 8 tabelas, todo `.from(<tabela>)` do
-- repositório foi lido e classificado por client:
--   - createAdminClient() (service_role) — bypassa RLS sempre, não afetado
--     por nenhuma mudança deste arquivo, em nenhum cenário.
--   - client de sessão (@/lib/supabase/server, cookies) ou client de
--     navegador (@/lib/supabase/client, anon key) — SUJEITO a RLS, o que
--     de fato precisa continuar funcionando depois desta migration.
--
-- Resultado da auditoria (grep exaustivo de .from()/.insert()/.update()/
-- .delete()/.upsert() nos 11 arquivos que só importam o client de
-- navegador e nos 11 arquivos que só importam o client de sessão sem
-- admin — nenhum INSERT/UPDATE/DELETE do Supabase encontrado fora de
-- admin.from(...) em nenhuma das 8 tabelas):
--
--   customers            SELECT — vendas/nova/page.tsx (browser, busca de
--                         cliente no PDV, qualquer usuario+) e
--                         relatorios/clientes/page.tsx (sessão,
--                         requirePageRole('gerente')). Nenhum
--                         INSERT/UPDATE/DELETE fora de admin (criação/edição
--                         de cliente sempre via POST/PATCH /api/clientes).
--   products              SELECT — 4 páginas de estoque/* (browser,
--                         dropdowns de produto). Estoque não está nos 9
--                         módulos bloqueados (20260812_open_cash_rpcs_to_
--                         usuario.sql) → usuario+.
--   product_variations    SELECT — mesmas páginas de estoque/*. Não tem
--                         company_id próprio — deriva de products.company_id.
--   sales                 SELECT — só relatorios/vendas/page.tsx (sessão,
--                         requirePageRole('gerente')). Toda escrita é via
--                         rpc_create_sale/rpc_cancel_sale/rpc_return_sale/
--                         rpc_process_exchange (SECURITY DEFINER).
--   sale_items            Nenhum acesso não-admin em lugar nenhum do
--                         repositório. Não tem company_id próprio — deriva
--                         de sales.company_id, mas nem precisa: nenhuma
--                         policy é necessária.
--   users                 Nenhum acesso não-admin em lugar nenhum do
--                         repositório — inclusive configuracoes/usuarios/
--                         page.tsx e configuracoes/colecoes/page.tsx, que
--                         importam createClient() (sessão) só para
--                         .auth.getUser(), nunca para consultar `users`
--                         (isso sempre é admin.from('users')). Explica a
--                         divergência encontrada entre
--                         20260811_enable_rls_users_same_company.sql (cria
--                         users_select_same_company) e o banco real (essa
--                         policy não existe hoje): a migration nunca foi
--                         necessária para nenhum fluxo real da aplicação.
--                         Esta migration não recria essa policy — nega tudo
--                         para authenticated, mais seguro e igualmente
--                         funcional.
--   finance_entries       SELECT — só relatorios/financeiro/page.tsx
--                         (sessão, requirePageRole('gerente')). Todas as
--                         páginas de /financeiro/* usam admin.
--   cashback_transactions Nenhum acesso não-admin em lugar nenhum do
--                         repositório (jobs de cron e todas as páginas
--                         usam admin).
--
-- PRINCÍPIO APLICADO: RLS para `authenticated` só precisa cobrir
-- exatamente as operações não-admin comprovadas acima. Onde nenhuma existe
-- (sale_items, users, cashback_transactions), a policy correta é NENHUMA
-- (nega tudo, só service_role acessa) — mesmo padrão já usado, e já
-- correto, nas tabelas novas de integração (company_integrations,
-- integration_secrets, external_entity_links, integration_outbox,
-- integration_event_deliveries, RLS habilitada sem nenhuma policy,
-- REVOKE ALL FROM PUBLIC/anon/authenticated). Onde existe algum SELECT
-- legítimo, a policy nova cobre exatamente esse comando, nunca ALL.
--
-- REGRA APLICADA CONTRA "ALL genérico" (pedido item 9): nenhuma tabela
-- abaixo recebe uma policy FOR ALL company-scoped sem checagem de role,
-- porque isso reabriria a mesma armadilha já identificada nesta auditoria:
-- uma policy ALL sem checagem de comando/role torna redundante (e inócua)
-- qualquer policy de DELETE/UPDATE mais restrita na mesma tabela, já que
-- policies permissivas se combinam por OR. Cada comando (SELECT/INSERT/
-- UPDATE/DELETE) tem sua própria policy, com seu próprio filtro de role
-- quando aplicável.
--
-- ROLES PRESERVADAS EXATAMENTE COMO JÁ ESTAVAM CODIFICADAS (não
-- simplificadas) nas policies antigas que tinham checagem de role:
--   customers_delete:        admin OU gerente
--   products_delete:         admin (sozinho, sem gerente)
--   product_variations_delete: admin (sozinho, sem gerente)
--   products_insert/update, product_variations_insert/update: admin OU gerente
--   sales_delete:             admin (sozinho, sem gerente)
--   sales_update:             admin OU gerente
--   finance_entries_insert/update/delete: admin OU gerente
-- Nenhuma dessas distinções foi alterada — só a ausência de company_id
-- nelas foi corrigida, e (para customers/sales/products/product_variations)
-- nenhuma policy de INSERT foi recriada onde a auditoria confirmou que
-- nenhum client não-admin jamais insere nessas tabelas hoje — ver nota
-- específica em cada bloco abaixo.
--
-- SECURITY DEFINER / RPCs — por que não são afetadas (nem precisam ser
-- alteradas, pedido item 6): rpc_create_sale, rpc_cancel_sale,
-- rpc_return_sale e rpc_process_exchange são SECURITY DEFINER. No
-- PostgreSQL, uma função SECURITY DEFINER executa com o papel do DONO da
-- função (não do chamador), e RLS por padrão NÃO restringe o dono de uma
-- tabela nem papéis com o atributo BYPASSRLS — só passaria a restringir se
-- a tabela tivesse FORCE ROW LEVEL SECURITY habilitado, o que a auditoria
-- live já confirmou ser `false` (`rls_forcado: false`) em todas as 11
-- tabelas verificadas. Como as migrations deste projeto são sempre
-- aplicadas por um papel com privilégio total (dono dos objetos), essas
-- RPCs hoje já ignoram inteiramente as policies de `authenticated` — antes
-- e depois desta migration, sem nenhuma mudança de comportamento. Nenhuma
-- RPC foi alterada por este arquivo.
-- =============================================================================


-- =============================================================================
-- 1. customers
-- =============================================================================

DROP POLICY IF EXISTS "authenticated_full_access" ON public.customers;
DROP POLICY IF EXISTS "customers_company"          ON public.customers; -- FOR ALL — substituída por policies por comando
DROP POLICY IF EXISTS "customers_select"           ON public.customers; -- USING(true), sem empresa
DROP POLICY IF EXISTS "customers_insert"            ON public.customers; -- WITH CHECK(true), sem empresa
DROP POLICY IF EXISTS "customers_update"           ON public.customers; -- USING(true), sem empresa
DROP POLICY IF EXISTS "customers_delete"           ON public.customers; -- recriada abaixo com company_id

-- SELECT: usado pelo PDV (browser, qualquer usuario+) e por
-- relatorios/clientes (sessão, gerente+ já garantido pela própria página) —
-- nenhuma restrição de role aqui, só de empresa, igual à policy antiga
-- customers_company já fazia para SELECT.
CREATE POLICY "customers_select_company" ON public.customers
  FOR SELECT TO authenticated
  USING (company_id = current_company_id());

-- INSERT/UPDATE: nenhum client não-admin faz isso hoje (confirmado —
-- criação/edição de cliente é sempre via POST/PATCH /api/clientes, que usa
-- service_role). Mantidas mesmo assim, escopadas por empresa e sem
-- restrição de role, para não remover uma capacidade que as policies
-- antigas (customers_insert/customers_update, ambas sem checagem de role)
-- já expunham deliberadamente — só a ausência de company_id era o
-- problema, não a ausência de checagem de role, que nunca existiu nelas.
CREATE POLICY "customers_insert_company" ON public.customers
  FOR INSERT TO authenticated
  WITH CHECK (company_id = current_company_id());

CREATE POLICY "customers_update_company" ON public.customers
  FOR UPDATE TO authenticated
  USING (company_id = current_company_id())
  WITH CHECK (company_id = current_company_id());

-- DELETE: preserva exatamente a checagem de role que já existia
-- (admin OU gerente), agora também escopada por empresa.
CREATE POLICY "customers_delete_company" ON public.customers
  FOR DELETE TO authenticated
  USING (
    company_id = current_company_id()
    AND get_user_role() = ANY (ARRAY['admin', 'gerente'])
  );


-- =============================================================================
-- 2. products
-- =============================================================================

DROP POLICY IF EXISTS "authenticated_full_access" ON public.products;
DROP POLICY IF EXISTS "products_company"           ON public.products; -- SELECT-only antiga, substituída por nome consistente
DROP POLICY IF EXISTS "products_select"            ON public.products; -- USING(true), sem empresa
DROP POLICY IF EXISTS "products_insert"            ON public.products; -- recriada abaixo com company_id
DROP POLICY IF EXISTS "products_update"            ON public.products; -- recriada abaixo com company_id
DROP POLICY IF EXISTS "products_delete"            ON public.products; -- recriada abaixo com company_id

CREATE POLICY "products_select_company" ON public.products
  FOR SELECT TO authenticated
  USING (company_id = current_company_id());

-- Nenhum client não-admin insere/atualiza/remove produto hoje (confirmado
-- — CRUD de produto é sempre via API routes/service_role). Mantidas com a
-- MESMA checagem de role que já existia (admin OU gerente para
-- insert/update; só admin para delete), agora também com company_id.
CREATE POLICY "products_insert_company" ON public.products
  FOR INSERT TO authenticated
  WITH CHECK (
    company_id = current_company_id()
    AND get_user_role() = ANY (ARRAY['admin', 'gerente'])
  );

CREATE POLICY "products_update_company" ON public.products
  FOR UPDATE TO authenticated
  USING (
    company_id = current_company_id()
    AND get_user_role() = ANY (ARRAY['admin', 'gerente'])
  )
  WITH CHECK (
    company_id = current_company_id()
    AND get_user_role() = ANY (ARRAY['admin', 'gerente'])
  );

CREATE POLICY "products_delete_company" ON public.products
  FOR DELETE TO authenticated
  USING (
    company_id = current_company_id()
    AND get_user_role() = 'admin'
  );


-- =============================================================================
-- 3. product_variations
-- =============================================================================
-- Não tem company_id próprio. Tenant derivado do relacionamento real já
-- existente no schema: product_variations.product_id -> products.id ->
-- products.company_id (confirmado nesta sessão via schema real do banco).
-- Antes desta migration, NENHUMA policy desta tabela filtrava por empresa
-- — nem mesmo a antiga product_variations_select (USING true).

DROP POLICY IF EXISTS "authenticated_full_access"    ON public.product_variations;
DROP POLICY IF EXISTS "product_variations_select"    ON public.product_variations; -- USING(true), sem empresa
DROP POLICY IF EXISTS "product_variations_insert"    ON public.product_variations; -- recriada abaixo com company_id
DROP POLICY IF EXISTS "product_variations_update"    ON public.product_variations; -- recriada abaixo com company_id
DROP POLICY IF EXISTS "product_variations_delete"    ON public.product_variations; -- recriada abaixo com company_id

CREATE POLICY "product_variations_select_company" ON public.product_variations
  FOR SELECT TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM public.products p
      WHERE p.id = product_variations.product_id
        AND p.company_id = current_company_id()
    )
  );

-- Mesma checagem de role que já existia (admin OU gerente para
-- insert/update; só admin para delete) — nenhum client não-admin faz isso
-- hoje, mantidas por paridade com o padrão de "products" acima.
CREATE POLICY "product_variations_insert_company" ON public.product_variations
  FOR INSERT TO authenticated
  WITH CHECK (
    get_user_role() = ANY (ARRAY['admin', 'gerente'])
    AND EXISTS (
      SELECT 1 FROM public.products p
      WHERE p.id = product_variations.product_id
        AND p.company_id = current_company_id()
    )
  );

CREATE POLICY "product_variations_update_company" ON public.product_variations
  FOR UPDATE TO authenticated
  USING (
    get_user_role() = ANY (ARRAY['admin', 'gerente'])
    AND EXISTS (
      SELECT 1 FROM public.products p
      WHERE p.id = product_variations.product_id
        AND p.company_id = current_company_id()
    )
  )
  WITH CHECK (
    get_user_role() = ANY (ARRAY['admin', 'gerente'])
    AND EXISTS (
      SELECT 1 FROM public.products p
      WHERE p.id = product_variations.product_id
        AND p.company_id = current_company_id()
    )
  );

CREATE POLICY "product_variations_delete_company" ON public.product_variations
  FOR DELETE TO authenticated
  USING (
    get_user_role() = 'admin'
    AND EXISTS (
      SELECT 1 FROM public.products p
      WHERE p.id = product_variations.product_id
        AND p.company_id = current_company_id()
    )
  );


-- =============================================================================
-- 4. sales
-- =============================================================================

DROP POLICY IF EXISTS "authenticated_full_access" ON public.sales;
DROP POLICY IF EXISTS "sales_company"              ON public.sales; -- SELECT-only antiga, substituída por nome consistente
DROP POLICY IF EXISTS "sales_select"               ON public.sales; -- USING(true), sem empresa
DROP POLICY IF EXISTS "sales_insert"               ON public.sales; -- WITH CHECK(true), sem empresa — NÃO recriada, ver nota
DROP POLICY IF EXISTS "sales_update"               ON public.sales; -- recriada abaixo com company_id
DROP POLICY IF EXISTS "sales_delete"               ON public.sales; -- recriada abaixo com company_id

CREATE POLICY "sales_select_company" ON public.sales
  FOR SELECT TO authenticated
  USING (company_id = current_company_id());

-- INSERT: NÃO recriada de propósito. Toda criação de venda é
-- exclusivamente via rpc_create_sale (SECURITY DEFINER, bypassa RLS
-- inteiramente, ver nota no cabeçalho) — nenhum client authenticated
-- insere em sales diretamente hoje, confirmado. Manter uma policy de
-- INSERT sem checagem de role (como a antiga sales_insert) seria abrir uma
-- via de escrita direta que nenhuma parte legítima do sistema usa.

CREATE POLICY "sales_update_company" ON public.sales
  FOR UPDATE TO authenticated
  USING (
    company_id = current_company_id()
    AND get_user_role() = ANY (ARRAY['admin', 'gerente'])
  )
  WITH CHECK (
    company_id = current_company_id()
    AND get_user_role() = ANY (ARRAY['admin', 'gerente'])
  );

CREATE POLICY "sales_delete_company" ON public.sales
  FOR DELETE TO authenticated
  USING (
    company_id = current_company_id()
    AND get_user_role() = 'admin'
  );


-- =============================================================================
-- 5. sale_items
-- =============================================================================
-- Nenhum acesso não-admin confirmado em lugar nenhum do repositório —
-- nem SELECT, nem INSERT. Toda leitura/escrita é via service_role (rotas
-- de API) ou dentro de rpc_create_sale/rpc_cancel_sale/etc (SECURITY
-- DEFINER, bypassa RLS). Policy correta: nenhuma — nega tudo para
-- authenticated/anon, só service_role acessa. Mesmo padrão já usado,
-- corretamente, nas tabelas de integração (20260817_integration_
-- foundation_schema.sql).

DROP POLICY IF EXISTS "authenticated_full_access" ON public.sale_items;
DROP POLICY IF EXISTS "sale_items_select"          ON public.sale_items; -- USING(true) — NÃO recriada
DROP POLICY IF EXISTS "sale_items_insert"          ON public.sale_items; -- WITH CHECK(true) — NÃO recriada

-- Nenhuma CREATE POLICY aqui — RLS habilitada sem policy para
-- authenticated = deny total (service_role continua com GRANT normal e
-- bypassa RLS, sem alteração).


-- =============================================================================
-- 6. users
-- =============================================================================
-- Nenhum acesso não-admin confirmado — todo .from('users') do repositório,
-- inclusive em arquivos que importam o client de sessão para outro fim
-- (.auth.getUser()), usa createAdminClient() para consultar esta tabela
-- especificamente. A policy users_select_same_company, criada em
-- 20260811_enable_rls_users_same_company.sql, não existe no banco real
-- (confirmado por consulta live) — esta migration não a recria, porque a
-- auditoria não encontrou nenhum fluxo legítimo que dependa dela. Negar
-- tudo para authenticated é mais seguro e igualmente funcional.

DROP POLICY IF EXISTS "authenticated_full_access"     ON public.users;
DROP POLICY IF EXISTS "users_select_same_company"     ON public.users; -- idempotência, caso já exista em outro ambiente

-- Nenhuma CREATE POLICY aqui — deny total para authenticated/anon.


-- =============================================================================
-- 7. finance_entries
-- =============================================================================
-- finance_entries_company já era a policy correta para SELECT (company_id
-- + role admin/gerente) — preservada sem alteração. finance_entries_select
-- era redundante E perigosa (checava role, mas não company_id — um
-- admin/gerente de QUALQUER empresa via essa policy sozinha). Removida.

DROP POLICY IF EXISTS "authenticated_full_access" ON public.finance_entries;
DROP POLICY IF EXISTS "finance_entries_select"     ON public.finance_entries; -- role-only, sem empresa — perigosa, removida
DROP POLICY IF EXISTS "finance_entries_insert"     ON public.finance_entries; -- recriada abaixo com company_id
DROP POLICY IF EXISTS "finance_entries_update"     ON public.finance_entries; -- recriada abaixo com company_id
DROP POLICY IF EXISTS "finance_entries_delete"     ON public.finance_entries; -- recriada abaixo com company_id
-- finance_entries_company: NÃO removida — já estava correta (company_id +
-- role). Recriada abaixo só para garantir idempotência caso este arquivo
-- seja reaplicado.
DROP POLICY IF EXISTS "finance_entries_company"    ON public.finance_entries;

CREATE POLICY "finance_entries_company" ON public.finance_entries
  FOR SELECT TO authenticated
  USING (
    company_id = current_company_id()
    AND get_user_role() = ANY (ARRAY['admin', 'gerente'])
  );

-- Nenhum client não-admin insere/atualiza/remove finance_entries hoje
-- (confirmado — todas as páginas de /financeiro/* usam admin). Mantidas
-- com a mesma checagem de role que já existia (admin OU gerente para os
-- três comandos), agora também com company_id.
CREATE POLICY "finance_entries_insert_company" ON public.finance_entries
  FOR INSERT TO authenticated
  WITH CHECK (
    company_id = current_company_id()
    AND get_user_role() = ANY (ARRAY['admin', 'gerente'])
  );

CREATE POLICY "finance_entries_update_company" ON public.finance_entries
  FOR UPDATE TO authenticated
  USING (
    company_id = current_company_id()
    AND get_user_role() = ANY (ARRAY['admin', 'gerente'])
  )
  WITH CHECK (
    company_id = current_company_id()
    AND get_user_role() = ANY (ARRAY['admin', 'gerente'])
  );

CREATE POLICY "finance_entries_delete_company" ON public.finance_entries
  FOR DELETE TO authenticated
  USING (
    company_id = current_company_id()
    AND get_user_role() = ANY (ARRAY['admin', 'gerente'])
  );


-- =============================================================================
-- 8. cashback_transactions
-- =============================================================================
-- Nenhum acesso não-admin confirmado em lugar nenhum do repositório (jobs
-- de cron e todas as páginas usam admin). Mesmo tratamento de sale_items/
-- users: nega tudo para authenticated, só service_role acessa.

DROP POLICY IF EXISTS "authenticated_full_access" ON public.cashback_transactions;

-- Nenhuma CREATE POLICY aqui — deny total para authenticated/anon.


-- =============================================================================
-- ROLLBACK
--
-- Restaura exatamente o estado confirmado pela auditoria live antes desta
-- migration (todas as policies abaixo existiam de fato no banco). Execute
-- no SQL Editor para reverter.
-- =============================================================================
/*

-- customers
DROP POLICY IF EXISTS "customers_select_company" ON public.customers;
DROP POLICY IF EXISTS "customers_insert_company" ON public.customers;
DROP POLICY IF EXISTS "customers_update_company" ON public.customers;
DROP POLICY IF EXISTS "customers_delete_company" ON public.customers;
CREATE POLICY "authenticated_full_access" ON public.customers FOR ALL TO authenticated USING (true) WITH CHECK (true);
CREATE POLICY "customers_company" ON public.customers FOR ALL TO authenticated USING (company_id = current_company_id());
CREATE POLICY "customers_delete" ON public.customers FOR DELETE TO authenticated USING (get_user_role() = ANY (ARRAY['admin','gerente']));
CREATE POLICY "customers_insert" ON public.customers FOR INSERT TO authenticated WITH CHECK (true);
CREATE POLICY "customers_select" ON public.customers FOR SELECT TO authenticated USING (true);
CREATE POLICY "customers_update" ON public.customers FOR UPDATE TO authenticated USING (true);

-- products
DROP POLICY IF EXISTS "products_select_company" ON public.products;
DROP POLICY IF EXISTS "products_insert_company" ON public.products;
DROP POLICY IF EXISTS "products_update_company" ON public.products;
DROP POLICY IF EXISTS "products_delete_company" ON public.products;
CREATE POLICY "authenticated_full_access" ON public.products FOR ALL TO authenticated USING (true) WITH CHECK (true);
CREATE POLICY "products_company" ON public.products FOR SELECT TO authenticated USING (company_id = current_company_id());
CREATE POLICY "products_delete" ON public.products FOR DELETE TO authenticated USING (get_user_role() = 'admin');
CREATE POLICY "products_insert" ON public.products FOR INSERT TO authenticated WITH CHECK (get_user_role() = ANY (ARRAY['admin','gerente']));
CREATE POLICY "products_select" ON public.products FOR SELECT TO authenticated USING (true);
CREATE POLICY "products_update" ON public.products FOR UPDATE TO authenticated USING (get_user_role() = ANY (ARRAY['admin','gerente']));

-- product_variations
DROP POLICY IF EXISTS "product_variations_select_company" ON public.product_variations;
DROP POLICY IF EXISTS "product_variations_insert_company" ON public.product_variations;
DROP POLICY IF EXISTS "product_variations_update_company" ON public.product_variations;
DROP POLICY IF EXISTS "product_variations_delete_company" ON public.product_variations;
CREATE POLICY "authenticated_full_access" ON public.product_variations FOR ALL TO authenticated USING (true) WITH CHECK (true);
CREATE POLICY "product_variations_delete" ON public.product_variations FOR DELETE TO authenticated USING (get_user_role() = 'admin');
CREATE POLICY "product_variations_insert" ON public.product_variations FOR INSERT TO authenticated WITH CHECK (get_user_role() = ANY (ARRAY['admin','gerente']));
CREATE POLICY "product_variations_select" ON public.product_variations FOR SELECT TO authenticated USING (true);
CREATE POLICY "product_variations_update" ON public.product_variations FOR UPDATE TO authenticated USING (get_user_role() = ANY (ARRAY['admin','gerente']));

-- sales
DROP POLICY IF EXISTS "sales_select_company" ON public.sales;
DROP POLICY IF EXISTS "sales_update_company" ON public.sales;
DROP POLICY IF EXISTS "sales_delete_company" ON public.sales;
CREATE POLICY "authenticated_full_access" ON public.sales FOR ALL TO authenticated USING (true) WITH CHECK (true);
CREATE POLICY "sales_company" ON public.sales FOR SELECT TO authenticated USING (company_id = current_company_id());
CREATE POLICY "sales_delete" ON public.sales FOR DELETE TO authenticated USING (get_user_role() = 'admin');
CREATE POLICY "sales_insert" ON public.sales FOR INSERT TO authenticated WITH CHECK (true);
CREATE POLICY "sales_select" ON public.sales FOR SELECT TO authenticated USING (true);
CREATE POLICY "sales_update" ON public.sales FOR UPDATE TO authenticated USING (get_user_role() = ANY (ARRAY['admin','gerente']));

-- sale_items
CREATE POLICY "authenticated_full_access" ON public.sale_items FOR ALL TO authenticated USING (true) WITH CHECK (true);
CREATE POLICY "sale_items_insert" ON public.sale_items FOR INSERT TO authenticated WITH CHECK (true);
CREATE POLICY "sale_items_select" ON public.sale_items FOR SELECT TO authenticated USING (true);

-- users
CREATE POLICY "authenticated_full_access" ON public.users FOR ALL TO authenticated USING (true) WITH CHECK (true);

-- finance_entries
DROP POLICY IF EXISTS "finance_entries_insert_company" ON public.finance_entries;
DROP POLICY IF EXISTS "finance_entries_update_company" ON public.finance_entries;
DROP POLICY IF EXISTS "finance_entries_delete_company" ON public.finance_entries;
DROP POLICY IF EXISTS "finance_entries_company" ON public.finance_entries;
CREATE POLICY "authenticated_full_access" ON public.finance_entries FOR ALL TO authenticated USING (true) WITH CHECK (true);
CREATE POLICY "finance_entries_company" ON public.finance_entries FOR SELECT TO authenticated USING ((company_id = current_company_id()) AND (get_user_role() = ANY (ARRAY['admin','gerente'])));
CREATE POLICY "finance_entries_delete" ON public.finance_entries FOR DELETE TO authenticated USING (get_user_role() = ANY (ARRAY['admin','gerente']));
CREATE POLICY "finance_entries_insert" ON public.finance_entries FOR INSERT TO authenticated WITH CHECK (get_user_role() = ANY (ARRAY['admin','gerente']));
CREATE POLICY "finance_entries_select" ON public.finance_entries FOR SELECT TO authenticated USING (get_user_role() = ANY (ARRAY['admin','gerente']));
CREATE POLICY "finance_entries_update" ON public.finance_entries FOR UPDATE TO authenticated USING (get_user_role() = ANY (ARRAY['admin','gerente']));

-- cashback_transactions
CREATE POLICY "authenticated_full_access" ON public.cashback_transactions FOR ALL TO authenticated USING (true) WITH CHECK (true);

*/
-- =============================================================================
-- FIM DA MIGRATION 20260820
-- =============================================================================
