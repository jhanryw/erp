-- =============================================================================
-- Fase 3 (CRM Omnichannel) — Entrega 6: envio outbound de mensagem
-- (ERP → N8N → Evolution). ERP é dono da mensagem e da decisão; Evolution é
-- só transporte, acionado via webhook N8N síncrono — nunca chamado direto
-- pelo ERP. Sem outbound frio nesta entrega (só resposta em conversa já
-- existente).
--
-- 1. crm_messages ganha client_dedupe_key — chave de idempotência de CRIAÇÃO
--    (clique duplo / retry de frontend), gerada pelo cliente ANTES de existir
--    qualquer resposta do provider. Índice único parcial escopado por
--    conversation_id + direction='outbound' — mesma mensagem lógica nunca
--    duplica mesmo sob corrida (find-first na service layer + catch de 23505
--    como rede de segurança, mesmo padrão de findOrCreateConversation).
--
-- 2. crm_messages ganha reply_to_message_id — suporte a "responder uma
--    mensagem específica" (self-FK, nullable). Sem ON DELETE explícito
--    (RESTRICT implícito) — mesma filosofia de histórico operacional já
--    aplicada às outras FKs desta tabela.
--
-- 3. rpc_apply_crm_message_status ganha p_external_message_id (DEFAULT NULL,
--    aditivo/retrocompatível com todos os chamadores da Entrega 5). É o
--    único jeito de preencher external_message_id pela primeira vez — a
--    transição inicial 'pending'→'sent' do outbound passa pela MESMA RPC da
--    Entrega 5 (é literalmente "status reportado pelo provider", só que
--    chega de forma síncrona em vez de por webhook assíncrono), ganhando de
--    graça checagem de ordem + sent_at/failed_at + idempotência.
-- =============================================================================

ALTER TABLE public.crm_messages
  ADD COLUMN IF NOT EXISTS client_dedupe_key   TEXT,
  ADD COLUMN IF NOT EXISTS reply_to_message_id BIGINT REFERENCES public.crm_messages(id);

CREATE UNIQUE INDEX IF NOT EXISTS uq_crm_messages_client_dedupe_key
  ON public.crm_messages(conversation_id, client_dedupe_key)
  WHERE direction = 'outbound' AND client_dedupe_key IS NOT NULL;

-- Acrescentar um parâmetro (mesmo com DEFAULT) muda a assinatura registrada
-- no catálogo (pronargs) — CREATE OR REPLACE NÃO substitui a função de 5
-- argumentos da Entrega 5, cria uma SEGUNDA função sobrecarregada, o que
-- deixaria a chamada de 5 argumentos ambígua. Precisa dropar a assinatura
-- antiga explicitamente antes de criar a nova.
DROP FUNCTION IF EXISTS public.rpc_apply_crm_message_status(int, bigint, text, timestamptz, text);

CREATE OR REPLACE FUNCTION public.rpc_apply_crm_message_status(
  p_company_id           int,
  p_message_id           bigint,
  p_new_status           text,
  p_occurred_at          timestamptz,
  p_failure_reason       text,
  p_external_message_id  text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
DECLARE
  v_ts             timestamptz;
  v_row_count      int;
  v_current_status text;
BEGIN
  IF p_new_status NOT IN ('sent', 'delivered', 'read', 'failed') THEN
    RAISE EXCEPTION 'status inválido para sincronização de provider: %.', p_new_status USING ERRCODE = 'P0001';
  END IF;

  v_ts := COALESCE(p_occurred_at, NOW());

  UPDATE crm_messages
  SET
    status              = p_new_status,
    status_updated_at    = NOW(),
    external_message_id = COALESCE(p_external_message_id, external_message_id),
    sent_at        = CASE WHEN p_new_status = 'sent'      AND sent_at      IS NULL THEN v_ts ELSE sent_at      END,
    delivered_at   = CASE WHEN p_new_status = 'delivered' AND delivered_at IS NULL THEN v_ts ELSE delivered_at END,
    read_at        = CASE WHEN p_new_status = 'read'      AND read_at      IS NULL THEN v_ts ELSE read_at      END,
    failed_at      = CASE WHEN p_new_status = 'failed'    AND failed_at    IS NULL THEN v_ts ELSE failed_at    END,
    failure_reason = CASE WHEN p_new_status = 'failed' THEN p_failure_reason ELSE failure_reason END
  WHERE id = p_message_id
    AND company_id = p_company_id
    AND direction = 'outbound'
    AND (
      CASE p_new_status
        WHEN 'sent'      THEN status = 'pending'
        WHEN 'delivered' THEN status IN ('pending', 'sent')
        WHEN 'read'      THEN status IN ('pending', 'sent', 'delivered')
        WHEN 'failed'    THEN status IN ('pending', 'sent')
        ELSE false
      END
    );

  GET DIAGNOSTICS v_row_count = ROW_COUNT;

  SELECT status INTO v_current_status
  FROM crm_messages
  WHERE id = p_message_id AND company_id = p_company_id;

  RETURN jsonb_build_object(
    'applied', v_row_count > 0,
    'current_status', v_current_status
  );
END;
$$;

GRANT EXECUTE ON FUNCTION public.rpc_apply_crm_message_status(int, bigint, text, timestamptz, text, text)
  TO service_role, authenticated;
