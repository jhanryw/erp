-- Fase Fiscal 5C — fundação de endereço/snapshot (parte 2/4).
--
-- Por quê: uma NF-e histórica não pode depender do endereço ATUAL do
-- cadastro do cliente (`customer_addresses`) — se o cliente mudar de
-- endereço depois, a venda antiga não pode "seguir" essa mudança. Proposta
-- aprovada em `docs/fiscal-fase5b-arquitetura-revisada.md` §8: tabela nova
-- e dedicada de snapshot, nunca colunas soltas em `shipments`/`sales`
-- (evita repetir o problema de `shipments.address_id`, que hoje nunca é
-- preenchido — confirmado por auditoria).
--
-- `source_address_id` é só rastreabilidade ("de onde veio esse dado quando
-- foi capturado") — nunca lido de volta para montar o payload fiscal; o
-- payload sempre lê `sale_recipients`, nunca `customer_addresses`
-- diretamente (ver mudança em `loadSaleFiscalContext.ts`).
--
-- RLS deny-by-default (só service_role), mesmo padrão de
-- `fiscal_documents`/`company_fiscal_settings` (20260821_focus_nfe_fiscal_
-- foundation.sql) — esta tabela carrega CPF/endereço completo por venda,
-- dado sensível o suficiente para não ser exposto via policy aberta. Toda
-- escrita/leitura passa pelas rotas de API (admin client), nunca pelo
-- browser client diretamente.
--
-- Idempotente: CREATE TABLE IF NOT EXISTS. Reversível: DROP TABLE (nenhuma
-- outra tabela depende dela via FK ainda).

CREATE TABLE IF NOT EXISTS public.sale_recipients (
  id                SERIAL PRIMARY KEY,
  sale_id           INT NOT NULL UNIQUE REFERENCES public.sales(id) ON DELETE CASCADE,
  company_id        INT NOT NULL REFERENCES public.companies(id),
  source_address_id INT REFERENCES public.customer_addresses(id),

  nome              TEXT NOT NULL,
  cpf               TEXT,
  cnpj              TEXT,
  telefone          TEXT,

  cep               TEXT NOT NULL,
  logradouro        TEXT NOT NULL,
  numero            TEXT NOT NULL,
  complemento       TEXT,
  bairro            TEXT NOT NULL,
  municipio         TEXT NOT NULL,
  municipio_ibge    CHAR(7),
  uf                CHAR(2) NOT NULL,
  ibge_source       TEXT,

  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),

  CONSTRAINT sale_recipients_municipio_ibge_format
    CHECK (municipio_ibge IS NULL OR municipio_ibge ~ '^\d{7}$'),
  CONSTRAINT sale_recipients_uf_format
    CHECK (uf ~ '^[A-Z]{2}$'),
  CONSTRAINT sale_recipients_cep_format
    CHECK (cep ~ '^\d{8}$'),
  CONSTRAINT sale_recipients_ibge_source_valid
    CHECK (ibge_source IS NULL OR ibge_source IN ('viacep', 'resolve_municipio_ibge', 'manual_confirmado'))
);

CREATE INDEX IF NOT EXISTS idx_sale_recipients_company_id ON public.sale_recipients(company_id);
CREATE INDEX IF NOT EXISTS idx_sale_recipients_source_address_id ON public.sale_recipients(source_address_id);

ALTER TABLE public.sale_recipients ENABLE ROW LEVEL SECURITY;
-- Nenhuma policy — deny-by-default, só service_role acessa (mesmo padrão
-- das tabelas fiscais). Ver header desta migration.

COMMENT ON TABLE public.sale_recipients IS
  'Snapshot IMUTÁVEL do destinatário/endereço de entrega usado em uma venda específica, no momento da venda. Nunca atualizado depois de criado (exceto correção humana pontual). Fonte de verdade do destinatário fiscal — não customer_addresses/shipments.address_id.';
COMMENT ON COLUMN public.sale_recipients.source_address_id IS
  'Rastreabilidade apenas — de qual customer_addresses este snapshot foi copiado, se algum. Nunca lido para montar payload fiscal.';
