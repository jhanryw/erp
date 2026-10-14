-- Barra de anúncios, rodapé institucional e WhatsApp flutuante do site de atacado.
--
-- Só persiste o que é NOVO:
--   * wholesale_site_announcements — várias mensagens ordenáveis (tabela própria);
--   * wholesale_site_settings.announcement_interval_seconds e site_chrome (JSONB validado no app:
--     rodapé, dados da loja, redes sociais e botão flutuante).
-- NÃO duplica: logo (Media Hub, role 'logo'), número de WhatsApp (wholesale_site_settings.whatsapp_phone — o MESMO da
-- finalização do carrinho), texto institucional (texts.footerText) nem dados fiscais (company_fiscal_settings).
-- 100% aditiva e reaplicável; o app tem fallback seguro se esta migration ainda não existir.

CREATE TABLE IF NOT EXISTS public.wholesale_site_announcements (
  id               BIGSERIAL    PRIMARY KEY,
  company_id       INT          NOT NULL REFERENCES public.companies(id),
  message          TEXT         NOT NULL CHECK (char_length(btrim(message)) BETWEEN 1 AND 160),
  -- http(s) ou caminho relativo do próprio site; nunca javascript:/data:.
  link_url         TEXT         CHECK (link_url IS NULL OR (char_length(link_url) <= 500 AND link_url ~* '^(https?://[^[:space:]]+|/[^/[:space:]][^[:space:]]*|/)$')),
  background_color TEXT         NOT NULL DEFAULT '#A71818' CHECK (background_color ~ '^#[0-9A-Fa-f]{6}$'),
  text_color       TEXT         NOT NULL DEFAULT '#FFFFFF' CHECK (text_color ~ '^#[0-9A-Fa-f]{6}$'),
  is_active        BOOLEAN      NOT NULL DEFAULT true,
  sort_order       INT          NOT NULL DEFAULT 0,
  created_at       TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  updated_at       TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_wholesale_site_announcements_company
  ON public.wholesale_site_announcements (company_id, is_active, sort_order);

DROP TRIGGER IF EXISTS trg_wholesale_site_announcements_touch_updated_at ON public.wholesale_site_announcements;
CREATE TRIGGER trg_wholesale_site_announcements_touch_updated_at
  BEFORE UPDATE ON public.wholesale_site_announcements
  FOR EACH ROW EXECUTE FUNCTION public.company_integrations_touch_updated_at();

ALTER TABLE public.wholesale_site_announcements ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.wholesale_site_announcements FROM PUBLIC, anon, authenticated;
GRANT ALL ON public.wholesale_site_announcements TO service_role;
GRANT USAGE, SELECT ON SEQUENCE public.wholesale_site_announcements_id_seq TO service_role;

ALTER TABLE public.wholesale_site_settings
  ADD COLUMN IF NOT EXISTS announcement_interval_seconds INT   NOT NULL DEFAULT 5,
  ADD COLUMN IF NOT EXISTS site_chrome                   JSONB NOT NULL DEFAULT '{}'::jsonb;

ALTER TABLE public.wholesale_site_settings DROP CONSTRAINT IF EXISTS chk_wholesale_site_settings_announcement_interval;
ALTER TABLE public.wholesale_site_settings ADD CONSTRAINT chk_wholesale_site_settings_announcement_interval
  CHECK (announcement_interval_seconds BETWEEN 3 AND 30);

ALTER TABLE public.wholesale_site_settings DROP CONSTRAINT IF EXISTS chk_wholesale_site_settings_chrome;
ALTER TABLE public.wholesale_site_settings ADD CONSTRAINT chk_wholesale_site_settings_chrome
  CHECK (jsonb_typeof(site_chrome) = 'object' AND octet_length(site_chrome::text) <= 16000);

-- ROLLBACK
/*
ALTER TABLE public.wholesale_site_settings DROP CONSTRAINT IF EXISTS chk_wholesale_site_settings_chrome;
ALTER TABLE public.wholesale_site_settings DROP CONSTRAINT IF EXISTS chk_wholesale_site_settings_announcement_interval;
ALTER TABLE public.wholesale_site_settings DROP COLUMN IF EXISTS site_chrome, DROP COLUMN IF EXISTS announcement_interval_seconds;
DROP TABLE IF EXISTS public.wholesale_site_announcements;
*/
