-- =============================================================================
-- 202609091201_sale_push_notifications.sql
--
-- Garante idempotência do push de "nova venda": no máximo uma notificação por
-- sales.id, mesmo que o caminho de criação da venda seja chamado mais de uma
-- vez para a mesma venda (retry, corrida entre chamadas, futuro refactor).
-- O claim é feito via INSERT único ANTES de enviar o push — se a linha já
-- existe, o envio é pulado.
-- =============================================================================

CREATE TABLE IF NOT EXISTS public.sale_push_notifications (
  sale_id  BIGINT       PRIMARY KEY REFERENCES public.sales(id) ON DELETE CASCADE,
  sent_at  TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

ALTER TABLE public.sale_push_notifications ENABLE ROW LEVEL SECURITY;

-- Sem policy de leitura/escrita para authenticated — só o service_role
-- (usado pelo backend de push) opera nesta tabela.
GRANT ALL ON public.sale_push_notifications TO service_role;
