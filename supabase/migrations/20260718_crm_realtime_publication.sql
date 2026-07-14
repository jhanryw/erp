-- =============================================================================
-- Fase 3 (CRM Omnichannel) — Inbox em tempo real (Supabase Realtime).
--
-- Habilita crm_messages e crm_conversations na publication supabase_realtime
-- — sem isso, o client nunca recebe eventos postgres_changes dessas tabelas,
-- mesmo com RLS/subscribe corretos no frontend.
--
-- IF NOT EXISTS evita erro de "tabela já pertence à publication" caso uma
-- das duas (ou as duas) já tenha sido adicionada manualmente via Dashboard —
-- não encontrei nenhuma migration anterior no repositório que toque
-- supabase_realtime, então a princípio nenhuma das duas está incluída ainda,
-- mas a forma idempotente é a segura independente do estado real do banco
-- (não verificável a partir do sandbox de desenvolvimento).
--
-- RLS existente (`crm_messages_company`, `crm_conversations_company`, ambas
-- `company_id = current_company_id()`) continua sendo a fronteira de
-- segurança real — Realtime aplica RLS por assinante. O filtro explícito
-- por company_id no `.channel(...).on('postgres_changes', ...)` do
-- frontend é defesa em profundidade/redução de tráfego, não a única
-- barreira.
--
-- Aditiva, não toca nenhuma migration anterior.
-- =============================================================================

ALTER PUBLICATION supabase_realtime ADD TABLE IF NOT EXISTS public.crm_messages;
ALTER PUBLICATION supabase_realtime ADD TABLE IF NOT EXISTS public.crm_conversations;
