-- =============================================================================
-- 20260627_sellers_responsible.sql
--
-- Fase 1 — Vendedor responsável
--
-- Objetivo: separar "quem processou no sistema" (seller_id = auth user)
--   de "quem vendeu de fato" (responsible_seller_id → sellers.id).
--   O computador da loja fica logado sempre na mesma conta; o vendedor
--   responsável é selecionado manualmente no início de cada venda.
--
-- O que este arquivo cria:
--   1. Tabela sellers (Jhanry, Yasmim, Halécia + futuros)
--   2. Coluna sales.responsible_seller_id (nullable, backward-compat)
--   3. Seed dos 3 vendedores, vinculando Halécia ao user_id dela
-- =============================================================================

-- ─── 1. Tabela sellers ───────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.sellers (
  id          SERIAL      PRIMARY KEY,
  name        TEXT        NOT NULL,
  user_id     UUID        REFERENCES auth.users(id) ON DELETE SET NULL,
  company_id  INT         NOT NULL,
  active      BOOLEAN     NOT NULL DEFAULT TRUE,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  CONSTRAINT sellers_name_company_unique UNIQUE (name, company_id)
);

COMMENT ON TABLE  public.sellers IS 'Vendedores que aparecem no campo "Vendedor responsável" da venda.';
COMMENT ON COLUMN public.sellers.user_id IS 'Vínculo com auth.users — permite auto-seleção ao logar.';

-- Permissões
GRANT SELECT ON public.sellers TO authenticated, service_role;
GRANT INSERT, UPDATE ON public.sellers TO service_role;

-- ─── 2. Coluna responsible_seller_id em sales ────────────────────────────────

ALTER TABLE public.sales
  ADD COLUMN IF NOT EXISTS responsible_seller_id INT REFERENCES public.sellers(id) ON DELETE SET NULL;

COMMENT ON COLUMN public.sales.responsible_seller_id IS 'Vendedor responsável pela venda (selecionado manualmente). Diferente de seller_id que é o usuário do sistema.';

CREATE INDEX IF NOT EXISTS idx_sales_responsible_seller
  ON public.sales (responsible_seller_id)
  WHERE responsible_seller_id IS NOT NULL;

-- ─── 3. Seed — Jhanry, Yasmim, Halécia ──────────────────────────────────────
-- Usa company_id da conta da vendedora (f9065bc1-...) como referência.
-- Se o usuário não existir (ambiente de teste), o seed é ignorado.

DO $$
DECLARE
  v_company_id INT;
  v_halecia_uid UUID := 'f9065bc1-7f6d-49bb-b192-f044d31541ca';
BEGIN
  SELECT company_id INTO v_company_id
  FROM public.users
  WHERE id = v_halecia_uid;

  IF v_company_id IS NULL THEN
    RAISE NOTICE 'Seed sellers: usuário % não encontrado ou sem company_id — seed ignorado.', v_halecia_uid;
    RETURN;
  END IF;

  -- Jhanry (sem login no sistema)
  INSERT INTO public.sellers (name, user_id, company_id, active)
  VALUES ('Jhanry', NULL, v_company_id, TRUE)
  ON CONFLICT (name, company_id) DO NOTHING;

  -- Yasmim (sem login no sistema)
  INSERT INTO public.sellers (name, user_id, company_id, active)
  VALUES ('Yasmim', NULL, v_company_id, TRUE)
  ON CONFLICT (name, company_id) DO NOTHING;

  -- Halécia — vinculada ao user_id da conta logada
  INSERT INTO public.sellers (name, user_id, company_id, active)
  VALUES ('Halécia', v_halecia_uid, v_company_id, TRUE)
  ON CONFLICT (name, company_id) DO UPDATE
    SET user_id = EXCLUDED.user_id;

  RAISE NOTICE 'Seed sellers: Jhanry, Yasmim e Halécia inseridos para company_id=%.', v_company_id;
END;
$$;
