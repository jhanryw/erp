-- =============================================================================
-- Fase 3 (CRM Omnichannel) — Inbox em tempo real (Supabase Realtime).
--
-- Habilita crm_messages e crm_conversations na publication supabase_realtime
-- — sem isso, o client nunca recebe eventos postgres_changes dessas tabelas,
-- mesmo com RLS/subscribe corretos no frontend.
--
-- ALTER PUBLICATION ... ADD TABLE não aceita IF NOT EXISTS em nenhuma
-- versão do Postgres (essa cláusula não existe para ADD TABLE, só para
-- CREATE PUBLICATION) — tentativa anterior desta migration errou nisso e
-- falhou com "syntax error at or near NOT" ao aplicar. Idempotência real
-- aqui é checando pg_publication_tables antes de cada ADD TABLE, dentro de
-- um DO block — evita erro de "tabela já pertence à publication" caso uma
-- das duas (ou as duas) já tenha sido adicionada manualmente via Dashboard.
-- Não encontrei nenhuma migration anterior no repositório que toque
-- supabase_realtime, então a princípio nenhuma das duas está incluída
-- ainda, mas a forma idempotente é a segura independente do estado real do
-- banco (não verificável a partir do sandbox de desenvolvimento).
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

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_publication_tables
    WHERE pubname = 'supabase_realtime' AND schemaname = 'public' AND tablename = 'crm_messages'
  ) THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE public.crm_messages;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_publication_tables
    WHERE pubname = 'supabase_realtime' AND schemaname = 'public' AND tablename = 'crm_conversations'
  ) THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE public.crm_conversations;
  END IF;
END $$;
