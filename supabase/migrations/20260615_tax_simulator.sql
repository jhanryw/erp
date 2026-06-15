-- =============================================================================
-- 20260615_tax_simulator.sql
--
-- Fase 5: Simulador Tributário
--
-- Cria:
--   1. tax_simulation_settings  — defaults de UF e faturamento por empresa
--   2. tax_icms_rates           — alíquotas internas de ICMS por UF (Confaz 2024)
--   3. rpc_simulate_taxes       — RPC de simulação (retorna os 3 regimes de uma vez)
--
-- Premissas de simplificação (corretas para um simulador gerencial):
--   - Simples Nacional: Anexo I (Comércio). ICMS e tributos federais embutidos no DAS.
--   - Lucro Presumido: alíquotas fixas s/ receita bruta. Sem deduções de crédito.
--   - Lucro Real: PIS/COFINS sem crédito de entrada (conservador). IRPJ+CSLL = 34% do lucro.
--   - ICMS no destino: para LP/LR, effective ICMS = alíquota interna do estado de destino.
--     (A DIFAL pós-EC 87/2015 faz o total equivaler à alíquota interna do destino.)
--   - Sem ST, MVA, isenções, redução de base ou regimes diferenciados por NCM.
-- =============================================================================


-- =============================================================================
-- 1. tax_simulation_settings
-- =============================================================================

CREATE TABLE IF NOT EXISTS public.tax_simulation_settings (
  id              serial         PRIMARY KEY,
  company_id      int            NOT NULL UNIQUE DEFAULT 1,
  home_uf         text           NOT NULL DEFAULT 'RN'
                                 CHECK (LENGTH(home_uf) = 2),
  annual_revenue  numeric(14,2)  NOT NULL DEFAULT 360000
                                 CHECK (annual_revenue >= 0),
  updated_at      timestamptz    NOT NULL DEFAULT now(),
  updated_by      uuid           REFERENCES public.users(id)
);

COMMENT ON TABLE  public.tax_simulation_settings IS
  'Defaults do simulador tributário por empresa: estado de origem (home_uf) e faturamento anual estimado.';
COMMENT ON COLUMN public.tax_simulation_settings.annual_revenue IS
  'Faturamento bruto acumulado 12 meses — determina faixa do Simples Nacional (Anexo I).';
COMMENT ON COLUMN public.tax_simulation_settings.home_uf IS
  'Estado sede da empresa (ex: RN). Usado como UF de destino quando a venda é local.';

-- Row default para company_id = 1
INSERT INTO public.tax_simulation_settings (company_id, home_uf, annual_revenue)
VALUES (1, 'RN', 360000)
ON CONFLICT (company_id) DO NOTHING;

GRANT SELECT, UPDATE ON public.tax_simulation_settings TO authenticated, service_role;


-- =============================================================================
-- 2. tax_icms_rates
-- =============================================================================
-- Alíquota interna de ICMS por UF (vendas ao consumidor final).
-- Para vendas interestaduais (LP/LR), a DIFAL faz o total = alíquota_interna_destino,
-- portanto basta lookup pelo estado de DESTINO.
-- Simples Nacional: ICMS embutido no DAS — não consulta esta tabela.
-- =============================================================================

CREATE TABLE IF NOT EXISTS public.tax_icms_rates (
  uf                text           PRIMARY KEY   CHECK (LENGTH(uf) = 2),
  nome_estado       text           NOT NULL,
  internal_rate_pct numeric(5,2)   NOT NULL      CHECK (internal_rate_pct >= 0),
  updated_at        timestamptz    NOT NULL DEFAULT now()
);

COMMENT ON TABLE  public.tax_icms_rates IS
  'Alíquotas internas de ICMS por UF (Confaz 2024). Atualizar quando houver alteração de convênio.';
COMMENT ON COLUMN public.tax_icms_rates.internal_rate_pct IS
  'Alíquota interna geral (%). Para o simulador, usada como effective ICMS total na venda ao consumidor final.';

INSERT INTO public.tax_icms_rates (uf, nome_estado, internal_rate_pct) VALUES
  ('AC', 'Acre',                 17.00),
  ('AL', 'Alagoas',              18.00),
  ('AM', 'Amazonas',             20.00),
  ('AP', 'Amapá',                18.00),
  ('BA', 'Bahia',                20.50),
  ('CE', 'Ceará',                20.00),
  ('DF', 'Distrito Federal',     18.00),
  ('ES', 'Espírito Santo',       17.00),
  ('GO', 'Goiás',                17.00),
  ('MA', 'Maranhão',             22.00),
  ('MG', 'Minas Gerais',         18.00),
  ('MS', 'Mato Grosso do Sul',   17.00),
  ('MT', 'Mato Grosso',          17.00),
  ('PA', 'Pará',                 17.00),
  ('PB', 'Paraíba',              18.00),
  ('PE', 'Pernambuco',           20.50),
  ('PI', 'Piauí',                21.00),
  ('PR', 'Paraná',               19.50),
  ('RJ', 'Rio de Janeiro',       20.00),
  ('RN', 'Rio Grande do Norte',  20.00),
  ('RO', 'Rondônia',             17.50),
  ('RR', 'Roraima',              17.00),
  ('RS', 'Rio Grande do Sul',    17.00),
  ('SC', 'Santa Catarina',       17.00),
  ('SE', 'Sergipe',              18.00),
  ('SP', 'São Paulo',            18.00),
  ('TO', 'Tocantins',            20.00)
ON CONFLICT (uf) DO UPDATE
  SET internal_rate_pct = EXCLUDED.internal_rate_pct,
      nome_estado        = EXCLUDED.nome_estado,
      updated_at         = now();

GRANT SELECT ON public.tax_icms_rates TO authenticated, service_role;


-- =============================================================================
-- 3. rpc_simulate_taxes
-- =============================================================================
-- Calcula e compara os 3 regimes tributários para um par (preço, custo).
-- Retorna JSONB com resultados lado a lado — sem nenhuma escrita.
--
-- Parâmetros:
--   p_sale_price     — preço de venda (obrigatório)
--   p_cost           — custo real por unidade (obrigatório)
--   p_annual_revenue — faturamento anual bruto 12m (NULL = usa tax_simulation_settings)
--   p_uf_destino     — estado de destino da venda (NULL = home_uf da empresa)
--   p_company_id     — empresa (default 1)
--
-- Retorno: jsonb com chaves inputs / simples_nacional / lucro_presumido / lucro_real
-- =============================================================================

CREATE OR REPLACE FUNCTION public.rpc_simulate_taxes(
  p_sale_price     numeric,
  p_cost           numeric,
  p_annual_revenue numeric DEFAULT NULL,
  p_uf_destino     text    DEFAULT NULL,
  p_company_id     int     DEFAULT 1
)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $func$
DECLARE
  v_annual_revenue  numeric;
  v_uf_destino      text;
  v_home_uf         text;
  v_icms_rate       numeric;
  v_gross_profit    numeric;
  v_gross_margin    numeric;

  -- Simples Nacional
  v_sn_aliquota_nominal  numeric;
  v_sn_parcela_deduzir   numeric;
  v_sn_effective_rate    numeric;
  v_sn_das               numeric;
  v_sn_net_profit        numeric;
  v_sn_net_margin        numeric;

  -- Lucro Presumido
  v_lp_pis       numeric;
  v_lp_cofins    numeric;
  v_lp_irpj_csll numeric;
  v_lp_icms      numeric;
  v_lp_total     numeric;
  v_lp_net_profit numeric;
  v_lp_net_margin numeric;

  -- Lucro Real
  v_lr_pis         numeric;
  v_lr_cofins      numeric;
  v_lr_icms        numeric;
  v_lr_subtotal    numeric;
  v_lr_lucro_trib  numeric;
  v_lr_irpj_csll   numeric;
  v_lr_total       numeric;
  v_lr_net_profit  numeric;
  v_lr_net_margin  numeric;
BEGIN
  -- ── Validação ──────────────────────────────────────────────────────────────
  IF p_sale_price IS NULL OR p_sale_price <= 0 THEN
    RAISE EXCEPTION 'p_sale_price deve ser maior que zero.' USING ERRCODE = 'P0001';
  END IF;
  IF p_cost IS NULL OR p_cost < 0 THEN
    RAISE EXCEPTION 'p_cost não pode ser negativo.' USING ERRCODE = 'P0001';
  END IF;
  IF p_cost > p_sale_price THEN
    RAISE EXCEPTION 'p_cost (%) não pode ser maior que p_sale_price (%).',
      p_cost, p_sale_price USING ERRCODE = 'P0001';
  END IF;

  -- ── Resolve configurações da empresa ──────────────────────────────────────
  SELECT home_uf, annual_revenue
    INTO v_home_uf, v_annual_revenue
  FROM tax_simulation_settings
  WHERE company_id = p_company_id;

  v_home_uf        := COALESCE(v_home_uf, 'RN');
  v_annual_revenue := COALESCE(p_annual_revenue, v_annual_revenue, 360000);
  v_uf_destino     := UPPER(TRIM(COALESCE(p_uf_destino, v_home_uf)));

  -- ── ICMS do estado de destino (LP e LR) ───────────────────────────────────
  SELECT internal_rate_pct INTO v_icms_rate
  FROM tax_icms_rates WHERE uf = v_uf_destino;

  -- Fallback: SP 18% se UF não encontrado
  v_icms_rate := COALESCE(v_icms_rate, 18.00);

  -- ── Base ──────────────────────────────────────────────────────────────────
  v_gross_profit := p_sale_price - p_cost;
  v_gross_margin := ROUND(v_gross_profit / p_sale_price * 100, 2);

  -- ── SIMPLES NACIONAL — Anexo I (Comércio) ─────────────────────────────────
  -- Lei Complementar 123/2006 — Tabela do Anexo I (vigente 2018+)
  -- Fórmula: alíquota_efetiva = ((RBT12 × alíquota_nominal) − parcela_deduzir) / RBT12

  v_sn_aliquota_nominal := CASE
    WHEN v_annual_revenue <= 180000    THEN 0.0400
    WHEN v_annual_revenue <= 360000    THEN 0.0730
    WHEN v_annual_revenue <= 720000    THEN 0.0950
    WHEN v_annual_revenue <= 1800000   THEN 0.1070
    WHEN v_annual_revenue <= 3600000   THEN 0.1430
    WHEN v_annual_revenue <= 4800000   THEN 0.1900
    ELSE NULL  -- acima do limite: não elegível
  END;

  v_sn_parcela_deduzir := CASE
    WHEN v_annual_revenue <= 180000    THEN     0.00
    WHEN v_annual_revenue <= 360000    THEN  5940.00
    WHEN v_annual_revenue <= 720000    THEN 13860.00
    WHEN v_annual_revenue <= 1800000   THEN 22500.00
    WHEN v_annual_revenue <= 3600000   THEN 87300.00
    WHEN v_annual_revenue <= 4800000   THEN 378000.00
    ELSE NULL
  END;

  IF v_sn_aliquota_nominal IS NULL THEN
    -- Não elegível: faturamento acima de R$ 4,8M
    v_sn_das           := NULL;
    v_sn_effective_rate := NULL;
    v_sn_net_profit    := NULL;
    v_sn_net_margin    := NULL;
  ELSE
    v_sn_effective_rate := ROUND(
      ((v_annual_revenue * v_sn_aliquota_nominal) - v_sn_parcela_deduzir)
      / v_annual_revenue * 100, 4
    );
    v_sn_das        := ROUND(p_sale_price * v_sn_effective_rate / 100, 2);
    v_sn_net_profit := ROUND(p_sale_price - p_cost - v_sn_das, 2);
    v_sn_net_margin := ROUND(v_sn_net_profit / p_sale_price * 100, 2);
  END IF;

  -- ── LUCRO PRESUMIDO ───────────────────────────────────────────────────────
  -- PIS cumulativo:   0,65% s/ receita bruta
  -- COFINS cumulativo: 3,00% s/ receita bruta
  -- IRPJ: 15% × (8% presunção comércio) = 1,20% s/ receita
  -- CSLL:  9% × (12% presunção comércio) = 1,08% s/ receita
  -- ICMS:  alíquota interna destino (embutida no preço — "por dentro")
  -- Nota: ignora adicional IRPJ (10% s/ lucro > R$20k/mês) por simplicidade

  v_lp_pis        := ROUND(p_sale_price * 0.0065, 2);
  v_lp_cofins     := ROUND(p_sale_price * 0.0300, 2);
  v_lp_irpj_csll  := ROUND(p_sale_price * 0.0228, 2);  -- 1,2% + 1,08%
  v_lp_icms       := ROUND(p_sale_price * v_icms_rate / 100, 2);
  v_lp_total      := v_lp_pis + v_lp_cofins + v_lp_irpj_csll + v_lp_icms;
  v_lp_net_profit := ROUND(p_sale_price - p_cost - v_lp_total, 2);
  v_lp_net_margin := ROUND(v_lp_net_profit / p_sale_price * 100, 2);

  -- ── LUCRO REAL ────────────────────────────────────────────────────────────
  -- PIS não-cumulativo:   1,65% s/ receita (SEM crédito de entrada — conservador)
  -- COFINS não-cumulativo: 7,60% s/ receita (SEM crédito de entrada)
  -- ICMS: mesma lógica do LP
  -- IRPJ+CSLL: 34% sobre lucro tributável (receita − custo − PIS − COFINS − ICMS)
  --   (IRPJ 15% + adicional 10% + CSLL 9% = 34% — simplificado sem planejamento)

  v_lr_pis        := ROUND(p_sale_price * 0.0165, 2);
  v_lr_cofins     := ROUND(p_sale_price * 0.0760, 2);
  v_lr_icms       := ROUND(p_sale_price * v_icms_rate / 100, 2);
  v_lr_subtotal   := v_lr_pis + v_lr_cofins + v_lr_icms;
  v_lr_lucro_trib := GREATEST(0, p_sale_price - p_cost - v_lr_subtotal);
  v_lr_irpj_csll  := ROUND(v_lr_lucro_trib * 0.34, 2);
  v_lr_total      := v_lr_subtotal + v_lr_irpj_csll;
  v_lr_net_profit := ROUND(p_sale_price - p_cost - v_lr_total, 2);
  v_lr_net_margin := ROUND(v_lr_net_profit / p_sale_price * 100, 2);

  -- ── Retorno ───────────────────────────────────────────────────────────────
  RETURN jsonb_build_object(

    'inputs', jsonb_build_object(
      'sale_price',      p_sale_price,
      'cost',            p_cost,
      'gross_profit',    ROUND(v_gross_profit, 2),
      'gross_margin_pct', v_gross_margin,
      'annual_revenue',  v_annual_revenue,
      'uf_destino',      v_uf_destino,
      'icms_rate_pct',   v_icms_rate
    ),

    'simples_nacional', CASE
      WHEN v_sn_das IS NOT NULL THEN jsonb_build_object(
        'elegivel',           true,
        'das',                v_sn_das,
        'das_rate_pct',       v_sn_effective_rate,
        'icms',               0,
        'pis_cofins',         0,
        'irpj_csll',          0,
        'total_tax',          v_sn_das,
        'effective_rate_pct', v_sn_effective_rate,
        'net_revenue',        ROUND(p_sale_price - v_sn_das, 2),
        'net_profit',         v_sn_net_profit,
        'net_margin_pct',     v_sn_net_margin,
        'nota',               'ICMS e tributos federais embutidos no DAS. Sem ICMS separado.'
      )
      ELSE jsonb_build_object(
        'elegivel', false,
        'motivo',   'Faturamento anual acima do limite do Simples Nacional (R$ 4,8M).'
      )
    END,

    'lucro_presumido', jsonb_build_object(
      'pis',                v_lp_pis,
      'cofins',             v_lp_cofins,
      'irpj_csll',          v_lp_irpj_csll,
      'icms',               v_lp_icms,
      'total_tax',          ROUND(v_lp_total, 2),
      'effective_rate_pct', ROUND(v_lp_total / p_sale_price * 100, 2),
      'net_revenue',        ROUND(p_sale_price - v_lp_total, 2),
      'net_profit',         v_lp_net_profit,
      'net_margin_pct',     v_lp_net_margin,
      'nota',               'PIS/COFINS cumulativo. IRPJ presunção 8%, CSLL presunção 12%. Adicional IRPJ não incluído.'
    ),

    'lucro_real', jsonb_build_object(
      'pis',                v_lr_pis,
      'cofins',             v_lr_cofins,
      'irpj_csll',          v_lr_irpj_csll,
      'icms',               v_lr_icms,
      'total_tax',          ROUND(v_lr_total, 2),
      'effective_rate_pct', ROUND(v_lr_total / p_sale_price * 100, 2),
      'net_revenue',        ROUND(p_sale_price - v_lr_total, 2),
      'net_profit',         v_lr_net_profit,
      'net_margin_pct',     v_lr_net_margin,
      'nota',               'PIS/COFINS sem crédito de entrada (conservador). IRPJ+CSLL 34% sobre lucro real.'
    )
  );
END;
$func$;

GRANT EXECUTE ON FUNCTION public.rpc_simulate_taxes TO authenticated, service_role;

-- Exemplo de uso:
-- SELECT rpc_simulate_taxes(74.99, 22.32, 360000, 'SP');
-- SELECT rpc_simulate_taxes(84.99, 32.90, 720000, 'RJ');
-- SELECT rpc_simulate_taxes(49.99, 11.00);  -- usa defaults de tax_simulation_settings
