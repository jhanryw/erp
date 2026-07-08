-- =============================================================================
-- Fase 3 (CRM Omnichannel) — Entrega 5: sincronização de status
-- (Evolution → CRM), via N8N. Fecha o ciclo de mensagens antes de outbound
-- existir de fato — validação real desta entrega depende de uma mensagem
-- outbound sintética inserida manualmente (outbound ainda não é gerado por
-- nenhum fluxo do ERP).
--
-- Escopo: só sincronização de status de mensagens já existentes. Nenhuma
-- criação de mensagem, nenhuma tabela nova, nenhum envio real.
--
-- 1. crm_messages ganha sent_at/delivered_at/read_at/failed_at (aditivo,
--    nullable) — status_updated_at sozinho perde o momento exato de cada
--    etapa assim que a próxima chega (é sobrescrito). Cada coluna é escrita
--    uma única vez (a própria condição de aceitação da RPC abaixo já
--    garante isso, sem lógica extra de "só se ainda for null" fora dela).
--
-- 2. rpc_apply_crm_message_status — UPDATE condicional atômico. A condição
--    de aceitação é reavaliada pelo Postgres no momento do lock da linha
--    (mesma instrução que decide e escreve, sem janela entre leitura e
--    decisão) — isso é o que torna a operação segura sob concorrência real,
--    não uma checagem em JS antes de escrever.
--
--    Regra de aceitação por status alvo (não é rank numérico único — 'failed'
--    precisa de uma condição diferente das demais, teria colidido com
--    'sent' num esquema de rank simples):
--      sent      aceito se status atual = 'pending'
--      delivered aceito se status atual IN ('pending', 'sent')
--      read      aceito se status atual IN ('pending', 'sent', 'delivered')
--      failed    aceito se status atual IN ('pending', 'sent')  -- nunca sobrescreve delivered/read
--
--    direction='outbound' na WHERE é defesa em profundidade — a service
--    layer já confirma isso antes de chamar a RPC (via findMessageByExternalId
--    + checagem de direction), mas a RPC não confia cegamente no chamador.
--
--    Existência da mensagem é responsabilidade do chamador (findMessageByExternalId,
--    já existe desde a Entrega 3) — esta RPC assume que p_message_id já foi
--    confirmado antes de ser chamada, por isso não distingue "não encontrada"
--    de "status obsoleto" internamente; quem decide a mensagem/reason final
--    pro N8N é a service layer.
-- =============================================================================

ALTER TABLE public.crm_messages
  ADD COLUMN IF NOT EXISTS sent_at      TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS delivered_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS read_at      TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS failed_at    TIMESTAMPTZ;

CREATE OR REPLACE FUNCTION public.rpc_apply_crm_message_status(
  p_company_id     int,
  p_message_id     bigint,
  p_new_status     text,
  p_occurred_at    timestamptz,
  p_failure_reason text
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
    status = p_new_status,
    status_updated_at = NOW(),
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

GRANT EXECUTE ON FUNCTION public.rpc_apply_crm_message_status
  TO service_role, authenticated;
