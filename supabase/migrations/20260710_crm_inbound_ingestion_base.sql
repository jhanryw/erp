-- =============================================================================
-- Fase 3 (CRM Omnichannel) — Entrega 3: base de banco para ingestão inbound.
--
-- Escopo desta migration: só o que é necessário no banco para o endpoint
-- POST /api/automations/crm/inbound-message (ver rota + services no mesmo
-- commit). Sem UI, sem integração outbound, sem Media Hub.
--
-- Dois itens:
--   1. Índice único parcial em crm_channels.provider_instance_identifier —
--      corrige gap real encontrado na auditoria da Entrega 3: sem isso, duas
--      empresas configurando por engano a mesma instância Evolution tornariam
--      ambígua a resolução de company_id a partir desse campo (risco de
--      vazamento cross-tenant). Único toque num artefato já validado da
--      Entrega 1 — aditivo, não remove/altera nada existente.
--   2. rpc_find_or_create_crm_person_by_identity — atomicidade de
--      crm_persons + crm_channel_identities sob concorrência real (duas
--      mensagens quase simultâneas do mesmo número novo). Usa
--      pg_advisory_xact_lock escopado a (company_id, channel_type, value) —
--      serializa só tentativas concorrentes para o MESMO valor, não trava o
--      resto do sistema. Lock libera sozinho no fim da transação. Mesma
--      convenção de rpc_set_primary_media (SECURITY DEFINER, ERRCODE P0001).
--      Escopo da RPC é só pessoa+identidade — conversa (findOrCreateConversation)
--      e mensagem (createMessage) continuam em TypeScript, já são idempotentes
--      via índice único + retry desde a Entrega 2, não duplicado aqui em
--      PL/pgSQL de propósito.
--
-- Política de erro do endpoint (documentada aqui para contexto, aplicada na
-- rota): canal não encontrado ou inativo é ERRO PERMANENTE DE CONFIGURAÇÃO,
-- não falha transiente — a rota responde 422 (não 404), para não induzir
-- retry-loop automático em N8N/Evolution. Decisão do usuário.
-- =============================================================================

CREATE UNIQUE INDEX IF NOT EXISTS uq_crm_channels_provider_instance
  ON public.crm_channels(provider_instance_identifier)
  WHERE provider_instance_identifier IS NOT NULL;

CREATE OR REPLACE FUNCTION public.rpc_find_or_create_crm_person_by_identity(
  p_company_id              int,
  p_channel_type            crm_channel_type,
  p_value                   text,
  p_display_name            text,
  p_person_created_source   text,
  p_identity_created_source text
)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
DECLARE
  v_person_id           bigint;
  v_channel_identity_id bigint;
BEGIN
  IF p_value IS NULL OR btrim(p_value) = '' THEN
    RAISE EXCEPTION 'value não pode ser vazio.' USING ERRCODE = 'P0001';
  END IF;

  -- Caminho quente: identidade já existe (maioria dos casos em produção).
  SELECT person_id, id INTO v_person_id, v_channel_identity_id
  FROM crm_channel_identities
  WHERE company_id = p_company_id AND channel_type = p_channel_type AND value = p_value AND active
  LIMIT 1;

  IF FOUND THEN
    RETURN jsonb_build_object(
      'person_id', v_person_id, 'channel_identity_id', v_channel_identity_id,
      'person_created', false, 'identity_created', false
    );
  END IF;

  -- Serializa só tentativas concorrentes para o MESMO (company_id, channel_type, value).
  PERFORM pg_advisory_xact_lock(
    hashtextextended(p_company_id::text || ':' || p_channel_type::text || ':' || p_value, 0)
  );

  -- Re-checa depois do lock: outra transação pode ter vencido a corrida
  -- enquanto esta esperava.
  SELECT person_id, id INTO v_person_id, v_channel_identity_id
  FROM crm_channel_identities
  WHERE company_id = p_company_id AND channel_type = p_channel_type AND value = p_value AND active
  LIMIT 1;

  IF FOUND THEN
    RETURN jsonb_build_object(
      'person_id', v_person_id, 'channel_identity_id', v_channel_identity_id,
      'person_created', false, 'identity_created', false
    );
  END IF;

  INSERT INTO crm_persons (company_id, display_name, created_source)
  VALUES (p_company_id, COALESCE(NULLIF(btrim(p_display_name), ''), p_value), p_person_created_source)
  RETURNING id INTO v_person_id;

  INSERT INTO crm_channel_identities (company_id, person_id, channel_type, value, created_source)
  VALUES (p_company_id, v_person_id, p_channel_type, p_value, p_identity_created_source)
  RETURNING id INTO v_channel_identity_id;

  RETURN jsonb_build_object(
    'person_id', v_person_id, 'channel_identity_id', v_channel_identity_id,
    'person_created', true, 'identity_created', true
  );
END;
$$;

GRANT EXECUTE ON FUNCTION public.rpc_find_or_create_crm_person_by_identity
  TO service_role, authenticated;
