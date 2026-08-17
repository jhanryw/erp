-- FASE 0 (auditoria Chatwoot/Meta) — hardening pontual, escopo restrito ao
-- caminho que a integração futura vai reutilizar: camada de identidade/
-- conversação do CRM (crm_persons/crm_channel_identities/crm_conversations/
-- crm_messages).
--
-- Mesma classe de vulnerabilidade já corrigida em
-- 20260811_fix_rpc_identity_grants_tenant.sql para vendas/caixa/estoque, mas
-- que não cobriu as RPCs do CRM (criadas em migrations posteriores/paralelas
-- a essa correção): funções SECURITY DEFINER que recebem `p_company_id` como
-- parâmetro puro, sem cruzar com a empresa do usuário autenticado, e estavam
-- GRANT'adas a `authenticated` — qualquer usuário logado podia chamar
-- supabase.rpc(...) do navegador informando o `company_id` de outra empresa
-- e ler/escrever dados de CRM de terceiros (conversas, status de mensagem,
-- identidades de contato).
--
-- Todas as três funções abaixo são chamadas EXCLUSIVAMENTE pelo backend via
-- createAdminClient() (service_role) — confirmado por grep em todo `src/`:
--   rpc_find_or_create_crm_person_by_identity → src/services/crm/channel-identities.service.ts:201
--   rpc_apply_crm_message_status              → src/services/crm/messages.service.ts:276
--   rpc_search_crm_conversations              → src/services/crm/conversations.service.ts:389
-- Nenhum código client-side as chama. Revogar `authenticated` fecha o vetor
-- de chamada direta pelo navegador com `company_id` forjado, sem nenhuma
-- mudança de comportamento para o app (mesmo raciocínio documentado em
-- 20260811_fix_rpc_identity_grants_tenant.sql).
--
-- Fora de escopo desta migration (dívida técnica registrada à parte, fora do
-- caminho de integração Chatwoot/Meta): rpc_pagar_repasse_motoboy,
-- fn_main_store_id, rpc_stock_initialize, rpc_transfer_stock,
-- rpc_decrease_online_sale_stock, rpc_stock_transfer_bulk,
-- rpc_reconcile_stock_divergence, rpc_set_primary_media.

REVOKE EXECUTE ON FUNCTION public.rpc_find_or_create_crm_person_by_identity(
  int, crm_channel_type, text, text, text, text
) FROM authenticated;
GRANT  EXECUTE ON FUNCTION public.rpc_find_or_create_crm_person_by_identity(
  int, crm_channel_type, text, text, text, text
) TO service_role;

REVOKE EXECUTE ON FUNCTION public.rpc_apply_crm_message_status(
  int, bigint, text, timestamptz, text, text
) FROM authenticated;
GRANT  EXECUTE ON FUNCTION public.rpc_apply_crm_message_status(
  int, bigint, text, timestamptz, text, text
) TO service_role;

REVOKE EXECUTE ON FUNCTION public.rpc_search_crm_conversations(int, text) FROM authenticated;
GRANT  EXECUTE ON FUNCTION public.rpc_search_crm_conversations(int, text) TO service_role;
