-- =============================================================================
-- 20260821_focus_nfe_fiscal_foundation.sql
--
-- Fase Fiscal 1 — fundação mínima para suportar uma primeira NF-e manual em
-- HOMOLOGAÇÃO via Focus NFe. Não emite nada, não automatiza nada, não
-- integra Nuvemshop, não implementa NFC-e. Só schema.
--
-- DECISÕES DE DESENHO E EVIDÊNCIA QUE AS FUNDAMENTA:
--
--   1. companies não ganha nenhuma coluna nova. Confirmado (grep exaustivo
--      em todas as migrations) que nenhuma migration jamais alterou
--      public.companies para adicionar campo fiscal — e nenhuma migration
--      nova o faz aqui. Todo dado fiscal do emitente (CNPJ, razão social,
--      IE, endereço, CRT) vive em company_fiscal_settings, tabela nova e
--      isolada — menor superfície de risco do que alterar uma tabela usada
--      em dezenas de lugares do sistema.
--
--   2. Numeração de NF-e NÃO é gerenciada por este schema. Confirmado por
--      leitura ao vivo da documentação oficial (doc.focusnfe.com.br/
--      reference/emitir_nfe, lista completa de Body Params): os campos
--      `numero`/`serie` SIMPLESMENTE NÃO EXISTEM no payload de emissão de
--      NF-e — só aparecem no corpo da RESPOSTA (o que a Focus atribuiu).
--      Diferente da NFC-e (onde a doc documenta explicitamente numeração
--      opcional/manual), a NF-e não tem essa opção documentada em lugar
--      nenhum. Por isso fiscal_documents.number/series são preenchidos só
--      a partir da resposta da Focus, nunca enviados por nós — e
--      company_fiscal_settings não tem nenhuma coluna de
--      next_number/série própria (o pedido explicitamente proibiu
--      implementar isso "cegamente"; a pesquisa mostrou que não há nada
--      para implementar aqui, não que a implementação ficou pendente).
--
--   3. Máquina de estados de fiscal_documents.status baseada no
--      comportamento REAL confirmado da API (não em pending/processed/
--      failed genéricos):
--        draft                → criado, ainda montando/validando localmente
--        validation_failed    → falhou validação local, NUNCA chegou a
--                                chamar a Focus (terminal)
--        pending               → POST /v2/nfe enviado; cobre tanto o 202
--                                (`processando_autorizacao`, assíncrono
--                                padrão) quanto a janela síncrona do 201
--        authorized             → status="autorizado" (Focus/SEFAZ) —
--                                terminal, snapshot imutável a partir daqui
--        authorization_failed   → status="erro_autorizacao" — CONFIRMADO
--                                que a Focus usa o MESMO valor genérico
--                                tanto para rejeição real da SEFAZ quanto
--                                para falha técnica pós-processamento
--                                (exemplo real da doc: status_sefaz="598",
--                                mensagem_sefaz="Rejeição: Total da NF
--                                difere..." — ainda assim só
--                                erro_autorizacao). Por isso o detalhe fica
--                                em status_sefaz/status_message, nunca
--                                inventamos uma distinção que a API não dá.
--        submission_error        → a chamada HTTP em si falhou ANTES de
--                                qualquer processamento pela Focus/SEFAZ —
--                                400 (requisicao_invalida) ou 422
--                                (erro_validacao_schema, permissao_negada,
--                                pending_operation, already_processed) —
--                                todos usam campo `codigo`, não `status`,
--                                confirmado na doc. Diferente de
--                                authorization_failed porque aqui a SEFAZ
--                                nunca viu a tentativa.
--        cancelled/cancellation_failed → DELETE /v2/nfe/{ref}, valores
--                                `cancelado`/`erro_cancelamento`
--                                confirmados literalmente na doc.
--
--   4. fiscal_document_items existe como tabela dedicada (não JSONB dentro
--      de fiscal_documents) — decisão de manutenção/auditoria: permite
--      consulta/agregação futura (ex.: relatório de NCM mais emitido) sem
--      parsear JSON, e cada linha é um snapshot imutável por natureza
--      (nunca hoje é UPDATE, só INSERT no momento da emissão). Campos
--      tributários (base/alíquota/valor) ficam em tax_details JSONB
--      deliberadamente — o conjunto exato de campos depende do CRT/motor
--      de regras fiscais, que NÃO existe nesta fase (proibido pelo
--      escopo). Nenhum campo tributário fixo foi criado só para "completar
--      tabela", conforme instruído.
--
--   5. RLS de ambas as tabelas novas: habilitada, ZERO policies — mesmo
--      padrão já usado e comprovadamente correto em
--      20260817_integration_foundation_schema.sql (company_integrations,
--      integration_secrets, external_entity_links, integration_outbox) e
--      em 20260820_fix_rls_open_policies_tenant_isolation.sql (correção
--      das tabelas legadas). Nenhum client não-admin tem motivo para
--      acessar dado fiscal diretamente — toda leitura/escrita passa por
--      service_role (mesmo padrão de toda a infraestrutura de integrações
--      já auditada). REVOKE ALL FROM PUBLIC/anon/authenticated,
--      GRANT ALL TO service_role.
--
--   6. Reaproveita company_integrations_touch_updated_at() (já criada em
--      20260817) para os triggers de updated_at das duas tabelas novas —
--      não duplica função.
--
-- NÃO FEITO AQUI (fora de escopo desta migration/fase, por instrução
-- explícita): nenhuma alteração em integration_outbox/
-- integration_event_deliveries (fiscal não está automatizado via
-- sale.completed nesta fase); nenhum CFOP/CSOSN/CST preenchido em produto
-- nenhum; nenhuma linha inserida em nenhuma tabela nova por esta migration
-- (só schema).
-- =============================================================================


-- =============================================================================
-- 1. Estender company_integrations.provider para aceitar 'focus_nfe'
-- =============================================================================
-- Busca o nome real da constraint em vez de presumir (mesmo padrão
-- defensivo já usado em 20260818_integration_event_deliveries.sql) — a
-- migration original (20260817) não nomeou a constraint explicitamente.
DO $$
DECLARE
  v_conname text;
BEGIN
  SELECT conname INTO v_conname
  FROM pg_constraint
  WHERE conrelid = 'public.company_integrations'::regclass
    AND contype = 'c'
    AND pg_get_constraintdef(oid) ILIKE '%provider%chatwoot%';

  IF v_conname IS NOT NULL THEN
    EXECUTE format('ALTER TABLE public.company_integrations DROP CONSTRAINT %I', v_conname);
  END IF;
END $$;

ALTER TABLE public.company_integrations
  ADD CONSTRAINT company_integrations_provider_check
  CHECK (provider IN ('chatwoot', 'meta', 'nuvemshop', 'focus_nfe'));


-- =============================================================================
-- 2. company_fiscal_settings — cadastro fiscal do emitente + config de
-- operação NF-e. Um registro por empresa (UNIQUE em company_id).
-- =============================================================================

CREATE TABLE IF NOT EXISTS public.company_fiscal_settings (
  id                       BIGSERIAL    PRIMARY KEY,
  company_id               INT          NOT NULL UNIQUE REFERENCES public.companies(id),

  -- Emitente — nenhum destes existe em companies (confirmado, ver
  -- cabeçalho). Todos nullable: cadastro é incremental, ninguém deve travar
  -- em NOT NULL antes do dado real existir.
  cnpj                     TEXT,
  razao_social             TEXT,
  nome_fantasia            TEXT,
  inscricao_estadual       TEXT,
  crt                      SMALLINT     CHECK (crt BETWEEN 1 AND 4), -- 1=Simples Nacional, 2=Simples excesso sublimite, 3=Regime Normal, 4=MEI
  logradouro               TEXT,
  numero_endereco          TEXT,
  complemento              TEXT,
  bairro                   TEXT,
  municipio                TEXT,
  municipio_ibge           CHAR(7),
  uf                       CHAR(2),
  cep                      TEXT,

  -- Operação NF-e — deliberadamente SEM coluna de numeração/série própria,
  -- ver item 2 do cabeçalho desta migration.
  nfe_enabled              BOOLEAN      NOT NULL DEFAULT false,
  nfe_environment          TEXT         NOT NULL DEFAULT 'homologacao'
                              CHECK (nfe_environment IN ('homologacao', 'producao')),
  default_cfop_internal    TEXT,   -- CFOP padrão para operação dentro do estado — sem valor definido nesta fase (motor de regras fiscais não existe ainda)
  default_cfop_interstate  TEXT,   -- CFOP padrão para operação interestadual
  consumer_final_default   BOOLEAN      NOT NULL DEFAULT true,

  created_at               TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  updated_at               TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_company_fiscal_settings_company ON public.company_fiscal_settings (company_id);

DROP TRIGGER IF EXISTS trg_company_fiscal_settings_touch_updated_at ON public.company_fiscal_settings;
CREATE TRIGGER trg_company_fiscal_settings_touch_updated_at
  BEFORE UPDATE ON public.company_fiscal_settings
  FOR EACH ROW EXECUTE FUNCTION public.company_integrations_touch_updated_at();

ALTER TABLE public.company_fiscal_settings ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.company_fiscal_settings FROM PUBLIC, anon, authenticated;
GRANT ALL ON public.company_fiscal_settings TO service_role;
GRANT USAGE, SELECT ON SEQUENCE public.company_fiscal_settings_id_seq TO service_role;


-- =============================================================================
-- 3. fiscal_documents — cabeçalho do documento fiscal (só NF-e nesta fase)
-- =============================================================================

CREATE TABLE IF NOT EXISTS public.fiscal_documents (
  id                        BIGSERIAL    PRIMARY KEY,
  company_id                INT          NOT NULL REFERENCES public.companies(id),
  sale_id                   INT          NOT NULL REFERENCES public.sales(id),

  document_type             TEXT         NOT NULL DEFAULT 'nfe'
                               CHECK (document_type IN ('nfe')), -- só NFe nesta fase — NFC-e fica para depois, CHECK trivial de estender quando chegar a hora
  provider                  TEXT         NOT NULL DEFAULT 'focus_nfe'
                               CHECK (provider IN ('focus_nfe')),
  environment                TEXT         NOT NULL
                               CHECK (environment IN ('homologacao', 'producao')),

  -- ref enviada à Focus. Gerada pela aplicação (não pelo banco) antes do
  -- INSERT, porque o valor precisa ser conhecido ANTES da primeira
  -- chamada à Focus (é o parâmetro `ref` da requisição) — nunca derivada
  -- do próprio id da linha (evita o problema de "preciso do id para gerar
  -- o valor que preciso ter antes de inserir a linha").
  provider_ref               TEXT         NOT NULL,

  status                     TEXT         NOT NULL DEFAULT 'draft'
                               CHECK (status IN (
                                 'draft', 'validation_failed', 'pending',
                                 'authorized', 'authorization_failed',
                                 'submission_error', 'cancelled', 'cancellation_failed'
                               )),

  -- Preenchidos SÓ a partir da resposta da Focus — nunca enviados por nós
  -- (ver item 2 do cabeçalho: a NF-e não aceita numero/serie na requisição).
  number                      TEXT,
  series                       TEXT,
  access_key                   CHAR(44),
  authorization_protocol        TEXT,

  -- Detalhe do resultado — nunca inferido, sempre copiado literal da
  -- resposta da Focus (status_sefaz/mensagem_sefaz na autorização;
  -- codigo/mensagem nos erros 400/422 síncronos).
  status_sefaz                   TEXT,
  status_message                  TEXT,
  submission_error_code            TEXT,
  submission_error_message          TEXT,

  issued_at                    TIMESTAMPTZ,   -- quando o POST foi enviado à Focus
  authorized_at                 TIMESTAMPTZ,
  cancelled_at                   TIMESTAMPTZ,

  -- Resposta bruta da Focus, para depuração/reprocessamento — sanitizada
  -- antes de gravar (a resposta da Focus não deveria conter segredo, mas a
  -- mesma cautela já registrada nas rodadas anteriores desta auditoria se
  -- aplica: nunca confiar cegamente, sanitizar na camada de aplicação
  -- antes do INSERT, não só antes de logar).
  provider_payload                JSONB,

  created_at                       TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  updated_at                       TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

-- Idempotência/duplicidade — os 3 requisitos explícitos do pedido:

-- (a) "provider_ref deve ser determinística ou unique no escopo correto"
CREATE UNIQUE INDEX IF NOT EXISTS uq_fiscal_documents_provider_ref
  ON public.fiscal_documents (provider, provider_ref);

-- (b) "access_key deve ser unique quando preenchida"
CREATE UNIQUE INDEX IF NOT EXISTS uq_fiscal_documents_access_key
  ON public.fiscal_documents (access_key)
  WHERE access_key IS NOT NULL;

-- (c) "uma venda não pode gerar duas NF-e ativas por acidente" — no
-- máximo um documento AUTORIZADO por venda+tipo. Não bloqueia múltiplas
-- tentativas em draft/submission_error/authorization_failed (retry após
-- correção é esperado e não deve exigir mudar de venda).
CREATE UNIQUE INDEX IF NOT EXISTS uq_fiscal_documents_sale_authorized
  ON public.fiscal_documents (sale_id, document_type)
  WHERE status = 'authorized';

CREATE INDEX IF NOT EXISTS idx_fiscal_documents_company     ON public.fiscal_documents (company_id);
CREATE INDEX IF NOT EXISTS idx_fiscal_documents_sale         ON public.fiscal_documents (sale_id);
CREATE INDEX IF NOT EXISTS idx_fiscal_documents_status       ON public.fiscal_documents (status);

DROP TRIGGER IF EXISTS trg_fiscal_documents_touch_updated_at ON public.fiscal_documents;
CREATE TRIGGER trg_fiscal_documents_touch_updated_at
  BEFORE UPDATE ON public.fiscal_documents
  FOR EACH ROW EXECUTE FUNCTION public.company_integrations_touch_updated_at();

ALTER TABLE public.fiscal_documents ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.fiscal_documents FROM PUBLIC, anon, authenticated;
GRANT ALL ON public.fiscal_documents TO service_role;
GRANT USAGE, SELECT ON SEQUENCE public.fiscal_documents_id_seq TO service_role;


-- =============================================================================
-- 4. fiscal_document_items — snapshot fiscal por item, imutável após
-- criado (sempre INSERT, nunca UPDATE em uso normal)
-- =============================================================================

CREATE TABLE IF NOT EXISTS public.fiscal_document_items (
  id                    BIGSERIAL    PRIMARY KEY,
  fiscal_document_id    BIGINT       NOT NULL REFERENCES public.fiscal_documents(id) ON DELETE CASCADE,
  company_id            INT          NOT NULL REFERENCES public.companies(id), -- redundante com fiscal_document_id->company_id, mesmo padrão já usado em toda a infra de integrações (RLS/query direta sem join)

  sale_item_id           INT          REFERENCES public.sale_items(id),
  product_id              INT          REFERENCES public.products(id),
  variation_id              INT          REFERENCES public.product_variations(id),

  description                TEXT         NOT NULL,           -- snapshot do nome/descrição fiscal usada, imutável mesmo se products.name mudar depois
  quantity                    NUMERIC(12,4) NOT NULL CHECK (quantity > 0),
  unit                          TEXT         NOT NULL,           -- snapshot de products.unidade_med no momento da emissão
  unit_price                     NUMERIC(12,4) NOT NULL CHECK (unit_price >= 0),
  discount_amount                 NUMERIC(12,2) NOT NULL DEFAULT 0 CHECK (discount_amount >= 0),
  total_amount                     NUMERIC(12,2) NOT NULL CHECK (total_amount >= 0),

  ncm                                TEXT,
  cest                                 TEXT,
  origem                                SMALLINT CHECK (origem BETWEEN 0 AND 8),
  cfop                                   TEXT,
  csosn_cst                                TEXT, -- CSOSN (Simples Nacional) OU CST (demais regimes) — nunca os dois, decidido pelo CRT da empresa em company_fiscal_settings

  -- Base/alíquotas/valores tributários efetivamente enviados — JSONB de
  -- propósito: o conjunto exato de campos depende do CRT/motor de regras
  -- fiscais, que não existe nesta fase. Nenhum campo tributário fixo foi
  -- criado só para "completar tabela" (instrução explícita do pedido).
  tax_details                                JSONB,

  created_at                                  TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_fiscal_document_items_document ON public.fiscal_document_items (fiscal_document_id);
CREATE INDEX IF NOT EXISTS idx_fiscal_document_items_company  ON public.fiscal_document_items (company_id);

ALTER TABLE public.fiscal_document_items ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.fiscal_document_items FROM PUBLIC, anon, authenticated;
GRANT ALL ON public.fiscal_document_items TO service_role;
GRANT USAGE, SELECT ON SEQUENCE public.fiscal_document_items_id_seq TO service_role;


-- =============================================================================
-- ROLLBACK
-- =============================================================================
/*
DROP TABLE IF EXISTS public.fiscal_document_items;
DROP TABLE IF EXISTS public.fiscal_documents;
DROP TABLE IF EXISTS public.company_fiscal_settings;

ALTER TABLE public.company_integrations DROP CONSTRAINT IF EXISTS company_integrations_provider_check;
ALTER TABLE public.company_integrations
  ADD CONSTRAINT company_integrations_provider_check
  CHECK (provider IN ('chatwoot', 'meta', 'nuvemshop'));
*/
-- =============================================================================
-- FIM DA MIGRATION 20260821
-- =============================================================================
