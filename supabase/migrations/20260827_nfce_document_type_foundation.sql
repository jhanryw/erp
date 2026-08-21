-- =============================================================================
-- 20260827_nfce_document_type_foundation.sql
--
-- Fase Fiscal 4 (fundação) — primeiro passo aprovado do desenho em
-- docs/fiscal-fase4-nfce-arquitetura-proposta.md: generalizar
-- `document_type` nas RPCs de claim, SEM alterar nenhuma lógica de
-- claim/lease/begin/complete além de parametrizar o tipo de documento.
--
-- Escopo desta migration (nada além disso):
--   1. `fiscal_documents.document_type` passa a aceitar 'nfce' além de
--      'nfe' — CHECK ampliado, mesmo padrão de drop dinâmico já usado em
--      `20260821_focus_nfe_fiscal_foundation.sql:113-124`
--      (`company_integrations_provider_check`), porque o CHECK original é
--      inline/sem nome explícito e o nome autogerado pelo Postgres não
--      deve ser adivinhado.
--   2. `company_fiscal_settings` ganha `nfce_enabled`/`nfce_environment`
--      — AMBIENTE SEPARADO por tipo de documento (decisão explícita: não
--      um switch global único que colocaria NF-e e NFC-e em produção
--      simultaneamente por engano). `nfe_enabled`/`nfe_environment`
--      continuam exatamente como estão, intocados.
--   3. `rpc_claim_fiscal_emission` ganha `p_document_type text DEFAULT
--      'nfe'` — toda referência antes hardcoded a `'nfe'` no corpo agora
--      usa o parâmetro. DEFAULT 'nfe' preserva 100% de compatibilidade
--      com qualquer chamada posicional existente (inclusive o roteiro
--      manual `rpc_claim_fiscal_emission.concurrency.md`). Nenhuma outra
--      linha do corpo da função muda — mesma serialização, mesma
--      máquina de decisão (claimed/busy/already_authorized/
--      already_cancelled/reconciliation_required), mesmo tratamento de
--      ambiguidade/cast já corrigidos nas revisões anteriores.
--
-- `rpc_begin_fiscal_transmission` e `rpc_complete_fiscal_emission` NÃO
-- são tocadas nesta migration — confirmado na auditoria (Fase 4, §6) que
-- nenhuma das duas referencia `document_type` em nenhum ponto do corpo;
-- operam só por `id`+`claim_token`(+lease), agnósticas ao tipo de
-- documento.
-- =============================================================================


-- ─── 1. fiscal_documents.document_type aceita 'nfce' ────────────────────────

DO $$
DECLARE
  v_conname text;
BEGIN
  SELECT conname INTO v_conname
  FROM pg_constraint
  WHERE conrelid = 'public.fiscal_documents'::regclass
    AND contype = 'c'
    AND pg_get_constraintdef(oid) ILIKE '%document_type%';

  IF v_conname IS NOT NULL THEN
    EXECUTE format('ALTER TABLE public.fiscal_documents DROP CONSTRAINT %I', v_conname);
  END IF;
END $$;

ALTER TABLE public.fiscal_documents
  ADD CONSTRAINT fiscal_documents_document_type_check
  CHECK (document_type IN ('nfe', 'nfce'));

COMMENT ON COLUMN public.fiscal_documents.document_type IS 'nfe (modelo 55) ou nfce (modelo 65) — decidido por resolveFiscalDocumentType, nunca escolhido manualmente pelo operador em fluxo normal.';


-- ─── 2. company_fiscal_settings — ambiente/habilitação separados por tipo ───

ALTER TABLE public.company_fiscal_settings
  ADD COLUMN IF NOT EXISTS nfce_enabled     BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS nfce_environment TEXT    NOT NULL DEFAULT 'homologacao'
    CONSTRAINT chk_company_fiscal_settings_nfce_environment CHECK (nfce_environment IN ('homologacao', 'producao'));

COMMENT ON COLUMN public.company_fiscal_settings.nfce_enabled IS 'Habilitação de NFC-e — independente de nfe_enabled. A Focus trata como configuração separada do lado deles (erro empresa_nao_configurada é específico de NFC-e).';
COMMENT ON COLUMN public.company_fiscal_settings.nfce_environment IS 'Ambiente de NFC-e — DELIBERADAMENTE separado de nfe_environment (decisão explícita: nunca um switch único que arrisque colocar os dois tipos em produção juntos por engano).';


-- ─── 3. rpc_claim_fiscal_emission — document_type parametrizado ─────────────

-- Assinatura antiga (5 parâmetros) precisa ser derrubada explicitamente —
-- CREATE OR REPLACE com uma lista de parâmetros DIFERENTE cria uma
-- function OVERLOADED nova em vez de substituir (identidade de função no
-- Postgres inclui a assinatura), o que deixaria as duas versões
-- coexistindo e qualquer chamada posicional de 5 argumentos ainda caindo
-- na versão antiga (hardcoded 'nfe'). DROP explícito evita esse estado
-- ambíguo.
DROP FUNCTION IF EXISTS public.rpc_claim_fiscal_emission(int, int, text, text, int);

CREATE OR REPLACE FUNCTION public.rpc_claim_fiscal_emission(
  p_company_id    int,
  p_sale_id       int,
  p_provider_ref  text,
  p_environment   text,
  p_lease_seconds int DEFAULT 60,
  p_document_type text DEFAULT 'nfe'
)
RETURNS TABLE (
  decision                    text,
  id                           bigint,
  status                       text,
  provider_ref                 text,
  number                        text,
  series                         text,
  access_key                     text, -- coluna real é CHAR(44); corpo faz v_row.access_key::text
  authorization_protocol          text,
  status_sefaz                     text,
  status_message                    text,
  submission_error_code              text,
  submission_error_message            text,
  xml_path                             text,
  danfe_path                            text,
  submission_claim_token                 text,
  submission_lease_until                  timestamptz,
  submission_attempts                      int,
  submission_started_at                    timestamptz
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_row   public.fiscal_documents%ROWTYPE;
  v_token text;
BEGIN
  -- Serializa concorrência sobre ESTE documento específico — bloqueante
  -- (não SKIP LOCKED: aqui não há "outra linha pra pegar em vez desta",
  -- queremos que a segunda execução ESPERE a primeira terminar sua
  -- transação curta e reavalie o estado real, não pule pra outro lugar).
  -- ÚNICA MUDANÇA DE LÓGICA desta migration: `document_type = 'nfe'`
  -- virou `document_type = p_document_type` nas 3 referências abaixo
  -- (2 SELECTs + 1 INSERT) — mesmo comportamento de sempre quando chamado
  -- com o default 'nfe', agora também correto para 'nfce' com o mesmo
  -- claim_token/lease/submission_started_at por linha (uma linha
  -- fiscal_documents por company+sale+document_type, nunca uma por
  -- company+sale só — uma venda pode ter uma tentativa de NF-e E uma de
  -- NFC-e como linhas SEPARADAS, cada uma com seu próprio claim/lease).
  SELECT * INTO v_row
  FROM public.fiscal_documents
  WHERE company_id = p_company_id AND sale_id = p_sale_id AND document_type = p_document_type
  ORDER BY created_at DESC
  LIMIT 1
  FOR UPDATE;

  IF NOT FOUND THEN
    BEGIN
      INSERT INTO public.fiscal_documents (company_id, sale_id, document_type, provider, environment, provider_ref, status)
      VALUES (p_company_id, p_sale_id, p_document_type, 'focus_nfe', p_environment, p_provider_ref, 'draft')
      RETURNING * INTO v_row;
    EXCEPTION WHEN unique_violation THEN
      -- Corrida perdida no INSERT (outra transação criou a linha entre o
      -- SELECT acima não encontrar nada e este INSERT rodar) — re-busca
      -- com lock, nunca insere uma segunda.
      SELECT * INTO v_row
      FROM public.fiscal_documents
      WHERE company_id = p_company_id AND sale_id = p_sale_id AND document_type = p_document_type
      ORDER BY created_at DESC
      LIMIT 1
      FOR UPDATE;
    END;
  END IF;

  IF v_row.status = 'authorized' THEN
    RETURN QUERY SELECT 'already_authorized'::text, v_row.id, v_row.status, v_row.provider_ref, v_row.number, v_row.series, v_row.access_key::text, v_row.authorization_protocol, v_row.status_sefaz, v_row.status_message, v_row.submission_error_code, v_row.submission_error_message, v_row.xml_path, v_row.danfe_path, v_row.submission_claim_token, v_row.submission_lease_until, v_row.submission_attempts, v_row.submission_started_at;
    RETURN;
  END IF;

  IF v_row.status = 'cancelled' THEN
    RETURN QUERY SELECT 'already_cancelled'::text, v_row.id, v_row.status, v_row.provider_ref, v_row.number, v_row.series, v_row.access_key::text, v_row.authorization_protocol, v_row.status_sefaz, v_row.status_message, v_row.submission_error_code, v_row.submission_error_message, v_row.xml_path, v_row.danfe_path, v_row.submission_claim_token, v_row.submission_lease_until, v_row.submission_attempts, v_row.submission_started_at;
    RETURN;
  END IF;

  IF v_row.submission_lease_until IS NOT NULL AND v_row.submission_lease_until > NOW() THEN
    RETURN QUERY SELECT 'busy'::text, v_row.id, v_row.status, v_row.provider_ref, v_row.number, v_row.series, v_row.access_key::text, v_row.authorization_protocol, v_row.status_sefaz, v_row.status_message, v_row.submission_error_code, v_row.submission_error_message, v_row.xml_path, v_row.danfe_path, v_row.submission_claim_token, v_row.submission_lease_until, v_row.submission_attempts, v_row.submission_started_at;
    RETURN;
  END IF;

  IF v_row.submission_started_at IS NOT NULL THEN
    -- RISCO RESIDUAL #2 (fechado): lease livre/expirada NÃO é suficiente
    -- aqui. Existe evidência de que uma transmissão HTTP real foi
    -- despachada sob o claim mais recente (rpc_begin_fiscal_transmission
    -- rodou) e não sabemos o resultado — a única forma seria a Focus
    -- responder mais devagar que a lease, ou o processo ter morrido depois
    -- do POST. Em nenhum dos dois casos é seguro reclamar direto: força
    -- reconciliação (consulta à provider_ref na Focus) incondicionalmente,
    -- não importa o valor de `status`. Checagem deliberadamente
    -- independente de `status = 'pending'` (mais forte que a versão
    -- anterior desta função, que confiava em status sozinho).
    RETURN QUERY SELECT 'reconciliation_required'::text, v_row.id, v_row.status, v_row.provider_ref, v_row.number, v_row.series, v_row.access_key::text, v_row.authorization_protocol, v_row.status_sefaz, v_row.status_message, v_row.submission_error_code, v_row.submission_error_message, v_row.xml_path, v_row.danfe_path, v_row.submission_claim_token, v_row.submission_lease_until, v_row.submission_attempts, v_row.submission_started_at;
    RETURN;
  END IF;

  -- draft / validation_failed / submission_error / authorization_failed /
  -- cancellation_failed / pending-sem-transmissão-despachada, sem lease
  -- ativa e sem submission_started_at → nenhuma evidência de transmissão
  -- anterior → seguro reclamar direto (caso 1 do pedido do risco residual
  -- #2: "não houver evidência de transmissão anterior"). O caso
  -- `status='pending' AND submission_started_at IS NULL` só existe numa
  -- janela síncrona estreita entre o claim e rpc_begin_fiscal_transmission
  -- (validação/montagem do payload, sem I/O externo) — reclamar direto
  -- aqui é exatamente o que o pedido pede, não uma lacuna.
  v_token := gen_random_uuid()::text;

  -- ATENÇÃO — ambiguidade de identificador (bug real encontrado em teste
  -- manual contra Postgres real, fixture company_id=12/sale_id=642):
  -- `RETURNS TABLE(...)` acima declara `id`, `status`, `submission_attempts`
  -- etc. como parâmetros de SAÍDA — que o PL/pgSQL trata como variáveis
  -- visíveis em TODO o corpo da função, com o MESMO NOME das colunas de
  -- `fiscal_documents`. Qualquer referência NÃO qualificada a esses nomes
  -- dentro de um comando SQL que também toque essa tabela é ambígua sob
  -- `plpgsql.variable_conflict = error` (padrão do Postgres) — daí o erro
  -- "column reference "id" is ambiguous". Alvos de atribuição em
  -- INSERT/SET (`status = ...`, `submission_claim_token = ...`) NÃO sofrem
  -- disso — são sempre interpretados como nomes de coluna pela gramática
  -- SQL — só expressões (lado direito do SET, condições de WHERE) correm
  -- risco. Por isso o alias `fd` abaixo qualifica especificamente
  -- `fd.id` (WHERE) e `fd.submission_attempts` (lado direito do SET).
  UPDATE public.fiscal_documents AS fd
  SET submission_claim_token = v_token,
      submission_claimed_at  = NOW(),
      submission_lease_until = NOW() + make_interval(secs => p_lease_seconds),
      submission_attempts    = fd.submission_attempts + 1,
      submission_started_at  = NULL, -- reseta: este claim novo ainda não iniciou nenhuma transmissão.
      status                 = 'pending'
  WHERE fd.id = v_row.id
  RETURNING fd.* INTO v_row;

  RETURN QUERY SELECT 'claimed'::text, v_row.id, v_row.status, v_row.provider_ref, v_row.number, v_row.series, v_row.access_key::text, v_row.authorization_protocol, v_row.status_sefaz, v_row.status_message, v_row.submission_error_code, v_row.submission_error_message, v_row.xml_path, v_row.danfe_path, v_row.submission_claim_token, v_row.submission_lease_until, v_row.submission_attempts, v_row.submission_started_at;
END;
$$;

REVOKE ALL ON FUNCTION public.rpc_claim_fiscal_emission(int, int, text, text, int, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.rpc_claim_fiscal_emission(int, int, text, text, int, text) TO service_role;


-- =============================================================================
-- Smoke tests
-- =============================================================================

SELECT conname, pg_get_constraintdef(oid) FROM pg_constraint
WHERE conrelid = 'public.fiscal_documents'::regclass AND conname = 'fiscal_documents_document_type_check';
-- Esperado: 1 linha, definição contendo 'nfe' e 'nfce'

SELECT column_name FROM information_schema.columns
WHERE table_schema = 'public' AND table_name = 'company_fiscal_settings' AND column_name IN ('nfce_enabled', 'nfce_environment');
-- Esperado: 2 linhas

SELECT pg_get_function_identity_arguments(oid) FROM pg_proc
WHERE proname = 'rpc_claim_fiscal_emission' AND pronamespace = 'public'::regnamespace;
-- Esperado: 1 linha só (a antiga de 5 args deve ter sido derrubada pelo DROP acima),
-- terminando em "..., p_lease_seconds integer DEFAULT 60, p_document_type text DEFAULT 'nfe'::text"

-- =============================================================================
-- ROLLBACK
-- =============================================================================
/*
DROP FUNCTION IF EXISTS public.rpc_claim_fiscal_emission(int, int, text, text, int, text);
-- Recriar a versão de 5 parâmetros exigiria colar de volta o corpo de
-- 20260826_fiscal_emission_claim.sql — não duplicado aqui de propósito,
-- ver aquele arquivo se o rollback completo for necessário.

ALTER TABLE public.company_fiscal_settings
  DROP COLUMN IF EXISTS nfce_enabled,
  DROP COLUMN IF EXISTS nfce_environment;

DO $$
BEGIN
  ALTER TABLE public.fiscal_documents DROP CONSTRAINT IF EXISTS fiscal_documents_document_type_check;
  ALTER TABLE public.fiscal_documents ADD CONSTRAINT fiscal_documents_document_type_check CHECK (document_type IN ('nfe'));
END $$;
*/
-- =============================================================================
-- FIM DA MIGRATION
-- =============================================================================
