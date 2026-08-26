-- Hardening (Fase 9): revoga EXECUTE de PUBLIC/anon/authenticated nas 3
-- RPCs de emissão fiscal (claim/complete/begin). Achado CRÍTICO da
-- auditoria SQL real: essas funções são SECURITY DEFINER, owner
-- supabase_admin (superusuário, portanto ignoram RLS), sem nenhuma
-- validação interna de tenant/usuário — confiam 100% nos parâmetros
-- recebidos. As migrations originais (20260826_fiscal_emission_claim.sql,
-- 20260827_nfce_document_type_foundation.sql) usaram
-- "REVOKE ALL ... FROM PUBLIC" sem incluir anon/authenticated
-- explicitamente, deixando esses dois roles com EXECUTE via
-- default privileges do Supabase.
--
-- Único uso legítimo confirmado no código (auditoria local, não-SQL):
-- src/services/fiscal/submitNfeHomologacao.ts e
-- submitNfceHomologacao.ts, ambos exclusivamente via
-- createAdminClient() (service_role). Nenhum caminho de browser/anon/
-- authenticated depende dessas RPCs.
--
-- Não altera corpo, SECURITY DEFINER nem search_path — só grants.
-- postgres preservado por paridade (grant explícito real já existente
-- no banco, mesma lógica de rpc_create_sale).

REVOKE ALL ON FUNCTION public.rpc_claim_fiscal_emission(integer, integer, text, text, integer, text)
  FROM PUBLIC, anon, authenticated;

REVOKE ALL ON FUNCTION public.rpc_complete_fiscal_emission(bigint, text, text, text, text, text, text, text, text, text, text, text, text, jsonb, jsonb, jsonb, timestamptz, timestamptz)
  FROM PUBLIC, anon, authenticated;

REVOKE ALL ON FUNCTION public.rpc_begin_fiscal_transmission(bigint, text, jsonb, jsonb)
  FROM PUBLIC, anon, authenticated;

GRANT EXECUTE ON FUNCTION public.rpc_claim_fiscal_emission(integer, integer, text, text, integer, text)
  TO service_role, postgres;

GRANT EXECUTE ON FUNCTION public.rpc_complete_fiscal_emission(bigint, text, text, text, text, text, text, text, text, text, text, text, text, jsonb, jsonb, jsonb, timestamptz, timestamptz)
  TO service_role, postgres;

GRANT EXECUTE ON FUNCTION public.rpc_begin_fiscal_transmission(bigint, text, jsonb, jsonb)
  TO service_role, postgres;
