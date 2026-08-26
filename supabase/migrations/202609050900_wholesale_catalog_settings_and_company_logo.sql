-- Reformulação da vitrine de atacado — configuração por empresa (status do
-- catálogo, WhatsApp, pedido mínimo, exibição, Meta Pixel) + logo da
-- empresa via Media Hub existente.
--
-- Nenhuma tabela de catálogo/preço/estoque nova — reaproveita 100% da
-- fundação varejo/atacado já existente (products.wholesale_price,
-- product_variations.wholesale_price_override, stock_balances,
-- categories). Esta migration só ADICIONA: 1 tabela de configuração
-- (mesmo padrão de company_fiscal_settings — 1 linha por empresa) e 1
-- extensão aditiva no CHECK de media_usages.entity_type.

-- =============================================================================
-- 1. wholesale_site_settings — configuração do catálogo público por empresa.
-- Não reaproveita company_integrations (provider='meta' já é usado por
-- outbox/CAPI server-side — auditoria confirmou uso real distinto, ver
-- relatório da Fase 1) nem company_fiscal_settings.telefone (é o telefone
-- do EMITENTE fiscal, conceito diferente do WhatsApp comercial do
-- catálogo).
-- =============================================================================

CREATE TABLE IF NOT EXISTS public.wholesale_site_settings (
  id                    BIGSERIAL    PRIMARY KEY,
  company_id            INT          NOT NULL UNIQUE REFERENCES public.companies(id),

  -- Status — catálogo público ligado/desligado (seção 15 do pedido).
  catalog_active        BOOLEAN      NOT NULL DEFAULT true,

  -- Identidade — nome exibido no catálogo. Logo fica em media_usages
  -- (entity_type='company', role='logo'), nunca uma URL solta aqui.
  display_name          TEXT,

  -- WhatsApp — número completo (com DDI/DDD), nunca hardcoded no código.
  -- Nullable: fica claramente "não configurado" até o número real chegar.
  whatsapp_phone        TEXT,

  -- Pedido mínimo (seção 12 do pedido) — 300.00 é o valor comercial
  -- combinado HOJE pra Santtorini, usado só como DEFAULT desta migration
  -- (dado, não lógica) — nunca lido como constante em código.
  minimum_order_amount  NUMERIC(10,2) NOT NULL DEFAULT 300.00 CHECK (minimum_order_amount >= 0),

  -- Exibição — toggles simples, sem submenu de dezenas de opções.
  show_out_of_stock     BOOLEAN      NOT NULL DEFAULT false,
  show_stock_quantity   BOOLEAN      NOT NULL DEFAULT false,
  show_search           BOOLEAN      NOT NULL DEFAULT true,
  show_categories       BOOLEAN      NOT NULL DEFAULT true,

  -- Meta Pixel — client-side (fbq). Preparação para CAPI fica para uma
  -- fase futura própria (seção 17 do pedido) — nenhuma coluna nova extra
  -- por antecipação.
  pixel_enabled         BOOLEAN      NOT NULL DEFAULT false,
  pixel_id              TEXT,

  created_at            TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  updated_at            TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_wholesale_site_settings_company ON public.wholesale_site_settings (company_id);

-- Reaproveita a mesma função de trigger genérica já usada por
-- company_fiscal_settings/company_integrations (corpo idêntico: só toca
-- updated_at) — nunca duplicar a função.
DROP TRIGGER IF EXISTS trg_wholesale_site_settings_touch_updated_at ON public.wholesale_site_settings;
CREATE TRIGGER trg_wholesale_site_settings_touch_updated_at
  BEFORE UPDATE ON public.wholesale_site_settings
  FOR EACH ROW EXECUTE FUNCTION public.company_integrations_touch_updated_at();

-- RLS: mesmo padrão de company_fiscal_settings — só service_role.
-- Configuração é lida/escrita exclusivamente pelo servidor (tela de
-- configurações do ERP e o catálogo público), nunca por anon/authenticated
-- diretamente.
ALTER TABLE public.wholesale_site_settings ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.wholesale_site_settings FROM PUBLIC, anon, authenticated;
GRANT ALL ON public.wholesale_site_settings TO service_role;
GRANT USAGE, SELECT ON SEQUENCE public.wholesale_site_settings_id_seq TO service_role;

-- =============================================================================
-- 2. media_usages.entity_type ganha 'company' — logo da empresa reaproveita
-- 100% o Media Hub existente (bucket media-public já usado por produtos,
-- role='logo' já existe no CHECK de role desde a criação do Media Hub,
-- unicidade de 1-logo-por-entidade já garantida por
-- uq_media_usages_singular_role). Mesmo padrão já usado quando
-- 'crm_message' foi adicionado (20260711_crm_media_attachments.sql).
-- =============================================================================

ALTER TABLE public.media_usages DROP CONSTRAINT IF EXISTS media_usages_entity_type_check;
ALTER TABLE public.media_usages ADD CONSTRAINT media_usages_entity_type_check
  CHECK (entity_type IN ('product', 'product_variation', 'shipment', 'crm_message', 'company'));

-- =============================================================================
-- 3. wholesale_site_banners — banners rotativos da vitrine (seções 14-21 do
-- pedido). NÃO reaproveita media_usages(role='banner') porque
-- uq_media_usages_singular_role trava 'banner' como singular por entidade
-- (1 registro só) — uma empresa precisa de VÁRIOS banners ativos ao mesmo
-- tempo. Referencia `media` diretamente (mesmo bucket media-public já
-- usado por produto/logo — nenhum bucket novo, nenhuma tabela de mídia
-- nova). O upload em si continua passando por POST /api/media
-- (visibility='public'), que já restringe a jpeg/png/webp — mesmo
-- allowlist pedida na seção 17, reaproveitada sem duplicar validação.
-- =============================================================================

CREATE TABLE IF NOT EXISTS public.wholesale_site_banners (
  id            BIGSERIAL    PRIMARY KEY,
  company_id    INT          NOT NULL REFERENCES public.companies(id),
  media_id      BIGINT       NOT NULL REFERENCES public.media(id) ON DELETE RESTRICT,

  is_active     BOOLEAN      NOT NULL DEFAULT true,
  sort_order    INT          NOT NULL DEFAULT 0,

  -- Tipo de link (seção 19) — exatamente um destino preenchido conforme o
  -- tipo, garantido pelo CHECK abaixo (nunca confiado só na UI/API).
  link_type          TEXT     NOT NULL DEFAULT 'none' CHECK (link_type IN ('none', 'category', 'product', 'url')),
  link_category_id   INT      REFERENCES public.categories(id),
  link_product_id    INT      REFERENCES public.products(id),
  -- http:/https: validado na API (zod) — nunca javascript:/data: (seção 19).
  link_url           TEXT,

  created_at    TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  updated_at    TIMESTAMPTZ  NOT NULL DEFAULT NOW(),

  CONSTRAINT chk_wholesale_site_banners_link_target CHECK (
    (link_type = 'none'     AND link_category_id IS NULL     AND link_product_id IS NULL     AND link_url IS NULL) OR
    (link_type = 'category' AND link_category_id IS NOT NULL AND link_product_id IS NULL     AND link_url IS NULL) OR
    (link_type = 'product'  AND link_category_id IS NULL     AND link_product_id IS NOT NULL AND link_url IS NULL) OR
    (link_type = 'url'      AND link_category_id IS NULL     AND link_product_id IS NULL     AND link_url IS NOT NULL)
  )
);

CREATE INDEX IF NOT EXISTS idx_wholesale_site_banners_company_active
  ON public.wholesale_site_banners (company_id, is_active, sort_order);
CREATE INDEX IF NOT EXISTS idx_wholesale_site_banners_media ON public.wholesale_site_banners (media_id);

DROP TRIGGER IF EXISTS trg_wholesale_site_banners_touch_updated_at ON public.wholesale_site_banners;
CREATE TRIGGER trg_wholesale_site_banners_touch_updated_at
  BEFORE UPDATE ON public.wholesale_site_banners
  FOR EACH ROW EXECUTE FUNCTION public.company_integrations_touch_updated_at();

-- RLS: mesmo padrão de wholesale_site_settings — só service_role. O
-- catálogo público lê banners através do server (getActiveWholesaleBanners),
-- nunca direto do browser.
ALTER TABLE public.wholesale_site_banners ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.wholesale_site_banners FROM PUBLIC, anon, authenticated;
GRANT ALL ON public.wholesale_site_banners TO service_role;
GRANT USAGE, SELECT ON SEQUENCE public.wholesale_site_banners_id_seq TO service_role;

-- =============================================================================
-- ROLLBACK
-- =============================================================================
/*
DROP TABLE IF EXISTS public.wholesale_site_banners;

ALTER TABLE public.media_usages DROP CONSTRAINT IF EXISTS media_usages_entity_type_check;
ALTER TABLE public.media_usages ADD CONSTRAINT media_usages_entity_type_check
  CHECK (entity_type IN ('product', 'product_variation', 'shipment', 'crm_message'));

DROP TABLE IF EXISTS public.wholesale_site_settings;
*/
