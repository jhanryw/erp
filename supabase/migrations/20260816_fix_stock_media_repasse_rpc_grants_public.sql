-- FASE 0B (auditoria Chatwoot/Meta) — correção cirúrgica das 8 RPCs
-- SECURITY DEFINER restantes classificadas AINDA VULNERÁVEL/potencialmente
-- vulnerável na Fase 0, todas fora do caminho de integração Chatwoot/Meta
-- (repasse de motoboy, estoque, mídia).
--
-- Investigação exaustiva (arquivo por arquivo, chamador por chamador) antes
-- desta migration confirmou: ZERO chamadores client-side para qualquer uma
-- das 8. Todo caminho de aplicação real usa createAdminClient() (service_role)
-- com a identidade (`p_system_user_id`/`p_user_id`) sempre resolvida a partir
-- da sessão verificada no servidor (requireRole()), nunca de input do
-- cliente. Portanto nenhuma das 8 precisa continuar acessível por
-- `authenticated` — mesma classe de correção já aplicada em
-- 20260811_fix_rpc_identity_grants_tenant.sql (vendas/caixa/estoque) e em
-- 20260816_fix_crm_identity_rpc_grants_tenant.sql (CRM).
--
-- Diferença importante em relação às duas migrations acima: aquelas só
-- fizeram `REVOKE EXECUTE ... FROM authenticated`, sem tocar em PUBLIC. Por
-- padrão do Postgres/Supabase, `EXECUTE` em uma função nova é concedido a
-- PUBLIC (o que inclui `anon`) a menos que seja explicitamente revogado — e
-- nenhuma das duas migrations anteriores revogou de PUBLIC. Esta migration
-- segue o padrão mais completo e já usado neste mesmo projeto em
-- 202607302400_rpc_import_products_batch.sql e
-- 202607302600_pim_product_sku_identity.sql: `REVOKE ALL ... FROM PUBLIC`
-- (que cobre `anon` e `authenticated` de uma vez, e qualquer role futura),
-- seguido de `GRANT EXECUTE ... TO service_role`.
--
-- ACHADO PARA VERIFICAÇÃO SEPARADA (não corrigido nesta migration, fora do
-- escopo desta fase): a mesma lacuna (REVOKE só de `authenticated`, nunca de
-- PUBLIC/anon) provavelmente também existe nas RPCs já "corrigidas" em
-- 20260811 e 20260816 — recomendo rodar has_function_privilege('anon', ...)
-- nelas antes de considerar aquelas correções 100% completas. Ver bloco 9 do
-- script fase0_confirmar_schema_producao.sql.
--
-- Classificação de cada uma das 8 (nenhuma tem chamador legítimo client-side
-- — todas puderam receber o tratamento mais simples e seguro, sem tocar em
-- corpo/lógica de negócio):
--   rpc_pagar_repasse_motoboy       — A (só admin client, prioridade crítica: risco financeiro)
--   fn_main_store_id                — C (zero chamadores em src/; usada só internamente por outras SECURITY DEFINER, que rodam como o owner — não afetado pelo REVOKE)
--   rpc_stock_initialize            — A (só admin client)
--   rpc_transfer_stock              — A (só admin client)
--   rpc_decrease_online_sale_stock  — C (zero chamadores em src/)
--   rpc_stock_transfer_bulk         — A (só admin client; auth.uid() só aparece em comentário de exemplo de teste no rodapé da migration original, nunca em código de produção)
--   rpc_reconcile_stock_divergence  — C (zero chamadores em src/; sem GRANT/REVOKE explícito anterior)
--   rpc_set_primary_media           — A (só admin client; sem GRANT/REVOKE explícito anterior)

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN
    RAISE EXCEPTION
      'Role "service_role" não existe neste banco — confirme que este é um projeto Supabase padrão antes de aplicar esta migration.';
  END IF;
END $$;

-- 1. rpc_pagar_repasse_motoboy — prioridade crítica (fraude financeira cross-tenant)
REVOKE ALL ON FUNCTION public.rpc_pagar_repasse_motoboy(int, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.rpc_pagar_repasse_motoboy(int, uuid) TO service_role;

-- 2. fn_main_store_id
REVOKE ALL ON FUNCTION public.fn_main_store_id(int) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.fn_main_store_id(int) TO service_role;

-- 3. rpc_stock_initialize
REVOKE ALL ON FUNCTION public.rpc_stock_initialize(int, int, numeric, uuid, int) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.rpc_stock_initialize(int, int, numeric, uuid, int) TO service_role;

-- 4. rpc_transfer_stock
REVOKE ALL ON FUNCTION public.rpc_transfer_stock(int, int, int, int, text, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.rpc_transfer_stock(int, int, int, int, text, uuid) TO service_role;

-- 5. rpc_decrease_online_sale_stock
REVOKE ALL ON FUNCTION public.rpc_decrease_online_sale_stock(int, int, int, text, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.rpc_decrease_online_sale_stock(int, int, int, text, uuid) TO service_role;

-- 6. rpc_stock_transfer_bulk (assinatura idêntica nas duas migrations de
--    20260615 que a definem — REVOKE/GRANT não depende de qual corpo é o
--    vigente entre as duas)
REVOKE ALL ON FUNCTION public.rpc_stock_transfer_bulk(int, int, text, uuid, jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.rpc_stock_transfer_bulk(int, int, text, uuid, jsonb) TO service_role;

-- 7. rpc_reconcile_stock_divergence
REVOKE ALL ON FUNCTION public.rpc_reconcile_stock_divergence(text, uuid, boolean) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.rpc_reconcile_stock_divergence(text, uuid, boolean) TO service_role;

-- 8. rpc_set_primary_media
REVOKE ALL ON FUNCTION public.rpc_set_primary_media(uuid, bigint, text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.rpc_set_primary_media(uuid, bigint, text, text) TO service_role;

-- Reversão (não recomendada — reabre as vulnerabilidades):
--   GRANT EXECUTE ON FUNCTION public.<nome>(<assinatura>) TO authenticated;
