-- =============================================================================
-- 202608311200_wholesale_retail_schema_foundation.sql
--
-- Fundação de schema para a distinção comercial VAREJO/ATACADO (retail/
-- wholesale). Auditoria prévia (docs/varejo-atacado-audit-report.md,
-- 2026-08-25) confirmou: nenhum campo existente representa essa dimensão
-- hoje (achado já registrado independentemente em
-- src/lib/fiscal/resolveFiscalDocumentType.ts:28-34, de uma fase fiscal
-- anterior). Esta migration é PURAMENTE ADITIVA — nenhuma coluna existente é
-- alterada/renomeada, nenhum dado histórico precisa de backfill.
--
-- Decisões de negócio que fecham esta fundação (aprovadas em chat,
-- 2026-08-25, ver docs/varejo-atacado-audit-report.md seção P):
--   1. Comissão: fora de escopo (infraestrutura não existe hoje) — sale_type
--      fica disponível para um futuro módulo de comissão, mas nada de
--      comissão é criado aqui.
--   2. Preço de atacado segue A MESMA granularidade do preço de varejo
--      hoje efetivamente usado (products.base_price + fallback opcional em
--      product_variations.price_override — padrão confirmado em uso real
--      por COALESCE(pv.price_override, p.base_price) em várias views/RPCs,
--      ex. supabase/migrations/20260612_fix_vw_stock_live_balances.sql:31).
--      Por isso: wholesale_price espelha base_price, wholesale_price_override
--      espelha price_override — mesmo par produto-pai/variação, nunca um
--      modelo de preço por faixa/quantidade novo.
--   3. sale_type é dimensão COMERCIAL — deliberadamente distinta de
--      sales.sale_origin (canal de MARKETING do cliente, enum
--      customer_origin, já sobrecarregado hoje — ver achado da auditoria,
--      seção P.4) e de sales_channel (canal/origem OPERACIONAL da venda:
--      pos/manual/whatsapp/nuvemshop/wholesale_site). Nenhum dos três
--      enums é fundido — cada um continua podendo evoluir independente.
--
-- ─── sales.sale_type ──────────────────────────────────────────────────────
-- NOT NULL DEFAULT 'retail': toda venda histórica vira 'retail' automati-
-- camente (não existe atacado hoje, por definição de negócio) — nenhum
-- backfill manual necessário. Preservado automaticamente por cancelamento/
-- devolução (rpc_cancel_sale/rpc_return_sale só fazem UPDATE na linha
-- existente, nunca recriam a venda — confirmado lendo o corpo real das
-- duas RPCs nesta auditoria). Troca com itens novos (rpc_process_exchange +
-- src/app/api/vendas/[id]/troca/route.ts) cria uma venda NOVA e precisa
-- herdar sale_type explicitamente — tratado em código, não neste schema
-- (ver 202608311201_rpc_create_sale_wholesale_channel.sql e a rota de troca).
--
-- Imutabilidade: ao contrário de sale_origin (editável via
-- PATCH /api/vendas/[id]/editar), sale_type NÃO é exposto nesse endpoint —
-- confirmado que o schema Zod daquela rota já é um allowlist estrito que
-- não inclui esta coluna, então basta não adicioná-la lá (nenhuma mudança
-- de código extra necessária para garantir a imutabilidade pós-criação).
--
-- ─── sales.sales_channel ──────────────────────────────────────────────────
-- Nullable, SEM default — deliberadamente não adivinhamos 'pos' vs 'manual'
-- para o fluxo atual do PDV (essa distinção não existe na UI ainda, e
-- inventar uma classificação sem sinal real seria pior que deixar NULL).
-- Populado por enquanto só onde já temos um sinal inequívoco:
--   - Nuvemshop (webhook order/route.ts) → sempre 'nuvemshop', hardcoded.
--   - futuro site de atacado → 'wholesale_site', quando existir.
-- Vendas manuais/PDV atuais ficam com sales_channel NULL até o PDV ganhar
-- essa distinção (fora de escopo desta fase — ver docs/varejo-atacado-
-- audit-report.md, plano de fases, Fase 3+).
--
-- ─── products.wholesale_price / product_variations.wholesale_price_override ──
-- Ambos NULLABLE, sem backfill: produto sem preço de atacado cadastrado
-- simplesmente não é vendável em atacado ainda — não é um "buraco" de
-- dado, é o estado inicial correto (mesmo raciocínio do rollout de
-- base_price original). A resolução de preço por sale_type (incluindo a
-- política segura para "wholesale_price_missing") fica em
-- src/lib/pricing/resolveSalePrice.ts — não em constraint de banco, porque
-- produtos legados não podem ficar retroativamente inválidos.
--
-- ─── products.cst ─────────────────────────────────────────────────────────
-- Achado da auditoria (docs/varejo-atacado-audit-report.md, seção I):
-- o motor fiscal deste ERP (src/lib/fiscal/taxRules.ts) hoje deriva CSOSN
-- inteiramente do REGIME da empresa (company_fiscal_settings.crt) — CSOSN
-- é obrigatório só para CRT 1/4 (Simples Nacional/MEI), nunca varia por
-- produto (resolveIcmsCsosn sempre devolve '102'). CST (situação tributária
-- de ICMS pra Lucro Presumido/Real, CRT 2/3) NÃO tem nenhuma regra
-- implementada em taxRules.ts (SUPPORTED_CRT = [1,4] apenas). Ou seja: esta
-- coluna é INFORMATIVA/RESERVADA nesta fase — captura o dado (inclusive via
-- importação CSV) mas NÃO é lida por buildNfePayload/buildNfcePayload ainda,
-- para não fingir uma regra fiscal que o motor não implementa. Fica pronta
-- para quando CRT 2/3 ganhar suporte fiscal (fase própria, fora de escopo
-- aqui) ou para overrides de CSOSN por produto, se algum dia necessário.
-- =============================================================================

-- Nota de segurança operacional: todo CHECK novo abaixo é adicionado
-- NOT VALID + VALIDATE CONSTRAINT em passo separado — evita o full-table
-- scan sob ACCESS EXCLUSIVE que um `ADD CONSTRAINT ... CHECK` direto exige
-- pra validar linhas já existentes. `sales` é a maior tabela tocada aqui
-- (histórico de produção) — não vale o risco de lock longo numa tabela
-- viva por um CHECK que, de qualquer forma, é satisfeito trivialmente por
-- todas as linhas existentes (sale_type nasce sempre 'retail' via DEFAULT).
-- Sem precedente disso no projeto até aqui — introduzido por segurança.

ALTER TABLE public.products
  ADD COLUMN IF NOT EXISTS wholesale_price NUMERIC(10,2),
  ADD COLUMN IF NOT EXISTS cst TEXT;

ALTER TABLE public.products
  ADD CONSTRAINT products_wholesale_price_positive
    CHECK (wholesale_price IS NULL OR wholesale_price > 0) NOT VALID;
ALTER TABLE public.products
  VALIDATE CONSTRAINT products_wholesale_price_positive;

COMMENT ON COLUMN public.products.wholesale_price IS
  'Preço de atacado do produto-pai — espelha base_price (varejo). NULL = produto ainda não habilitado para venda em atacado. Ver src/lib/pricing/resolveSalePrice.ts para a política de resolução (incl. wholesale_price_missing).';
COMMENT ON COLUMN public.products.cst IS
  'CST (situação tributária ICMS, regime Lucro Presumido/Real) — reservado/informativo. O motor fiscal (src/lib/fiscal/taxRules.ts) hoje só implementa CSOSN para CRT 1/4 e não lê esta coluna ainda. Não confundir com CSOSN (não há coluna própria — resolveIcmsCsosn deriva de company_fiscal_settings.crt, nunca de produto).';

ALTER TABLE public.product_variations
  ADD COLUMN IF NOT EXISTS wholesale_price_override NUMERIC(10,2);

ALTER TABLE public.product_variations
  ADD CONSTRAINT product_variations_wholesale_price_override_positive
    CHECK (wholesale_price_override IS NULL OR wholesale_price_override > 0) NOT VALID;
ALTER TABLE public.product_variations
  VALIDATE CONSTRAINT product_variations_wholesale_price_override_positive;

COMMENT ON COLUMN public.product_variations.wholesale_price_override IS
  'Preço de atacado específico desta variação — espelha price_override (varejo). NULL = usa products.wholesale_price do produto-pai (mesma semântica de fallback já usada para price_override/base_price).';

ALTER TABLE public.sales
  ADD COLUMN IF NOT EXISTS sale_type TEXT NOT NULL DEFAULT 'retail',
  ADD COLUMN IF NOT EXISTS sales_channel TEXT;

ALTER TABLE public.sales
  ADD CONSTRAINT sales_sale_type_valid
    CHECK (sale_type IN ('retail', 'wholesale')) NOT VALID;
ALTER TABLE public.sales
  VALIDATE CONSTRAINT sales_sale_type_valid;

ALTER TABLE public.sales
  ADD CONSTRAINT sales_sales_channel_valid
    CHECK (sales_channel IS NULL OR sales_channel IN ('pos', 'manual', 'whatsapp', 'nuvemshop', 'wholesale_site')) NOT VALID;
ALTER TABLE public.sales
  VALIDATE CONSTRAINT sales_sales_channel_valid;

COMMENT ON COLUMN public.sales.sale_type IS
  'Modalidade COMERCIAL da venda — retail (padrão) ou wholesale. Distinto de sale_origin (canal de marketing) e de sales_channel (canal operacional). Gravado na criação (rpc_create_sale), imutável depois (não exposto em PATCH /api/vendas/[id]/editar). Preservado automaticamente por cancelamento/devolução (UPDATE na mesma linha); herdado explicitamente em troca com itens novos (venda nova) — ver src/app/api/vendas/[id]/troca/route.ts.';
COMMENT ON COLUMN public.sales.sales_channel IS
  'Canal/origem OPERACIONAL da venda — pos | manual | whatsapp | nuvemshop | wholesale_site. NULL para vendas manuais/PDV atuais (a UI ainda não distingue pos/manual/whatsapp — fase futura). Nuvemshop grava sempre ''nuvemshop'' hardcoded no webhook, nunca a partir de payload externo.';

CREATE INDEX IF NOT EXISTS idx_sales_company_sale_type
  ON public.sales (company_id, sale_type);

CREATE INDEX IF NOT EXISTS idx_sales_company_sales_channel
  ON public.sales (company_id, sales_channel)
  WHERE sales_channel IS NOT NULL;
