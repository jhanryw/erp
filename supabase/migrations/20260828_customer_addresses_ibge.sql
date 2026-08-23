-- Fase Fiscal 5C — fundação de endereço/snapshot (parte 1/4).
--
-- Por quê: `customer_addresses` existe no banco (confirmado por leitura em
-- `loadSaleFiscalContext.ts:108`/`vendas/[id]/imprimir/page.tsx:58`) mas não
-- tem nenhuma coluna de código IBGE — achado já documentado em
-- `20260823_ibge_municipios_cache.sql:8-9` e em
-- `docs/fiscal-fase5-vendas-entrega-auditoria.md`. Esta migration só
-- adiciona o que falta para o ERP parar de depender de digitação manual do
-- código IBGE (ver `resolveMunicipioIbge`/cascata ViaCEP em
-- `src/app/api/shipping/cep/route.ts`).
--
-- Idempotente: ADD COLUMN IF NOT EXISTS. Reversível: DROP COLUMN das duas
-- colunas novas (nenhuma outra tabela referencia estas colunas ainda).
-- Nenhuma coluna existente é removida ou renomeada.

ALTER TABLE public.customer_addresses
  ADD COLUMN IF NOT EXISTS municipio_ibge CHAR(7),
  ADD COLUMN IF NOT EXISTS ibge_source TEXT;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'customer_addresses_municipio_ibge_format'
  ) THEN
    ALTER TABLE public.customer_addresses
      ADD CONSTRAINT customer_addresses_municipio_ibge_format
      CHECK (municipio_ibge IS NULL OR municipio_ibge ~ '^\d{7}$');
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'customer_addresses_ibge_source_valid'
  ) THEN
    ALTER TABLE public.customer_addresses
      ADD CONSTRAINT customer_addresses_ibge_source_valid
      CHECK (ibge_source IS NULL OR ibge_source IN ('viacep', 'resolve_municipio_ibge', 'manual_confirmado'));
  END IF;
END $$;

COMMENT ON COLUMN public.customer_addresses.municipio_ibge IS
  'Código IBGE do município (7 dígitos). Resolvido automaticamente — nunca digitado pelo vendedor. Ver ibge_source para a origem.';
COMMENT ON COLUMN public.customer_addresses.ibge_source IS
  'Qual camada resolveu municipio_ibge: viacep (resposta do ViaCEP) | resolve_municipio_ibge (fallback por UF+nome via cache/API do IBGE) | manual_confirmado (correção humana, caso raro).';
