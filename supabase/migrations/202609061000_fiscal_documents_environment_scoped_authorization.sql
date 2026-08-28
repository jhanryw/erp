-- =============================================================================
-- 202609061000_fiscal_documents_environment_scoped_authorization.sql
--
-- Fundação para "mesma venda, dois ambientes" (auditoria homologação →
-- produção, 2026-09-06) — NÃO libera produção, NÃO altera o gate que
-- bloqueia emissão fora de homologação (`submitNfeHomologacao.ts`/
-- `submitNfceHomologacao.ts`, `settings.nfe_environment`/
-- `nfce_environment !== 'homologacao'` → 403). Só prepara o schema pra
-- que, quando essa fase futura remover o gate, a mesma venda possa ter:
--
--   fiscal_documents: sale_id=642, document_type='nfce', environment='homologacao', status='authorized'
--   fiscal_documents: sale_id=642, document_type='nfce', environment='producao',   status='authorized'
--
-- coexistindo — o que o schema ATUAL impede (achado da auditoria).
--
-- ─── Causa raiz auditada ─────────────────────────────────────────────────
--
-- `uq_fiscal_documents_sale_authorized` (20260821_focus_nfe_fiscal_
-- foundation.sql:254) é `UNIQUE (sale_id, document_type) WHERE
-- status='authorized'` — não inclui `environment`. Um documento
-- `authorized` de homologação já ocupa essa chave, então uma tentativa
-- posterior de autorizar o mesmo (sale_id, document_type) em produção
-- colidiria neste índice no momento em que `rpc_complete_fiscal_emission`
-- tentasse marcar a linha nova como `authorized`.
--
-- `rpc_claim_fiscal_emission` (20260827_nfce_document_type_foundation.sql)
-- já RECEBE `p_environment` como parâmetro (usado no INSERT da linha
-- nova), mas os dois SELECTs que localizam a linha existente pra
-- reclamar filtram só por `(company_id, sale_id, document_type)` — sem
-- `environment`. Resultado: uma linha de homologação `authorized` é
-- encontrada e devolvida como `already_authorized` mesmo quando
-- `p_environment='producao'` é passado, e a criação de uma linha
-- SEPARADA para produção nunca chega a acontecer.
--
-- ─── Auditoria de dados existentes ANTES desta migration ────────────────
--
-- Este índice está sendo AMPLIADO (mais colunas na chave), não reduzido —
-- alargar uma UNIQUE constraint nunca pode invalidar dados que já
-- satisfaziam a constraint mais estreita anterior: qualquer par
-- (sale_id, document_type) que hoje tem no máximo 1 linha `authorized`
-- (garantido pelo índice atual) continua tendo no máximo 1 linha
-- `authorized` por (sale_id, document_type, environment) depois — é
-- matematicamente impossível esta migration falhar por dado pré-
-- existente. Ainda assim, a query de verificação abaixo (fora de
-- transação, comentada) permite confirmar isso manualmente antes de
-- rodar, se desejado:
--
--   SELECT sale_id, document_type, COUNT(*) AS autorizados
--   FROM public.fiscal_documents
--   WHERE status = 'authorized'
--   GROUP BY sale_id, document_type
--   HAVING COUNT(*) > 1;
--   -- Esperado: 0 linhas (o índice atual já garante isso hoje).
--
-- ─── Por que incluir company_id (mesmo sendo redundante) ────────────────
--
-- `sale_id` é FK pra `sales.id`, uma PK global (BIGSERIAL/SERIAL de uma
-- única sequência pra todas as empresas) — um `sale_id` já pertence
-- inequivocamente a exatamente 1 `company_id`, então incluir `company_id`
-- na chave não muda o CONJUNTO de linhas que o índice bloquearia ou
-- permitiria (é redundante pra fins de unicidade). Incluído mesmo assim
-- por: (1) defesa em profundidade — nunca depender implicitamente da
-- integridade referencial de `sale_id→sales.id` pra uma garantia
-- multi-tenant crítica; (2) legibilidade — o índice fica autoexplicativo
-- sobre o escopo (empresa+venda+tipo+ambiente), consistente com o padrão
-- já usado no restante do schema fiscal (`idx_fiscal_documents_company`).
--
-- ─── O que esta migration NÃO faz ────────────────────────────────────────
--
--   - Não altera nenhuma linha existente de fiscal_documents (DDL puro,
--     nenhum UPDATE/DELETE).
--   - Não apaga nenhum documento de homologação.
--   - Não toca em access_key/qrcode_url/XML/status/environment/protocol
--     de linhas já existentes.
--   - Não remove nem enfraquece o gate de ambiente em
--     submitNfeHomologacao.ts/submitNfceHomologacao.ts — produção
--     continua bloqueada por aquele código, intocado.
--   - Não toca em rpc_complete_fiscal_emission — ela opera só por
--     `id`+`claim_token` (nunca por sale_id/document_type/environment),
--     e é compatível com o índice novo: a linha que ela atualiza já tem
--     o `environment` certo gravado desde o INSERT feito pelo claim.
--   - Não toca em rpc_begin_fiscal_transmission — mesma razão.
--   - Não altera provider_ref de documentos já existentes — só código
--     TypeScript (fora desta migration) passa a gerar refs NOVAS com
--     sufixo de ambiente; refs históricas continuam válidas como estão.
-- =============================================================================

BEGIN;

-- ─── 1. Índice de autorização — ganha `environment` na chave ────────────────

DROP INDEX IF EXISTS public.uq_fiscal_documents_sale_authorized;

CREATE UNIQUE INDEX IF NOT EXISTS uq_fiscal_documents_sale_authorized
  ON public.fiscal_documents (company_id, sale_id, document_type, environment)
  WHERE status = 'authorized';

COMMENT ON INDEX public.uq_fiscal_documents_sale_authorized IS
  'No máximo 1 documento AUTORIZADO por empresa+venda+tipo+AMBIENTE. Antes de 202609061000 não incluía environment — uma venda só podia ter 1 autorizado por tipo no total, impedindo homologação e produção coexistirem pra mesma venda. company_id é redundante pra unicidade (sale_id já é FK pra uma PK global) mas mantido por defesa em profundidade e legibilidade.';

-- ─── 2. rpc_claim_fiscal_emission — environment vira parte da identidade ────
--
-- Assinatura IDÊNTICA à atual (20260827_nfce_document_type_foundation.sql)
-- — `p_environment` já existia como parâmetro; só não era usado nos dois
-- SELECTs que localizam a linha a reclamar. CREATE OR REPLACE em cima da
-- MESMA assinatura substitui o corpo sem precisar de DROP FUNCTION (só é
-- necessário quando a lista de parâmetros muda). Toda a máquina de
-- decisão (claimed/busy/already_authorized/already_cancelled/
-- reconciliation_required), claim_token, lease, retries e o fechamento do
-- risco residual #2 (submission_started_at) permanecem EXATAMENTE como
-- estão — a ÚNICA mudança de lógica é `AND environment = p_environment`
-- nos dois SELECTs (inicial + fallback de corrida perdida no INSERT).

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
  --
  -- ÚNICA MUDANÇA DE LÓGICA desta migration (202609061000): `environment
  -- = p_environment` entra na identidade da linha reclamada, nas mesmas
  -- 3 referências que já tratavam `document_type` como parte da
  -- identidade (2 SELECTs + 1 INSERT — o INSERT já gravava `environment`,
  -- só os SELECTs não filtravam por ele). Uma venda agora pode ter até 4
  -- linhas fiscal_documents INDEPENDENTES pro mesmo document_type: nfce/
  -- homologacao, nfce/producao, nfe/homologacao, nfe/producao — cada uma
  -- com seu próprio claim_token/lease/submission_started_at, exatamente
  -- como nfe e nfce já eram linhas separadas entre si desde
  -- 20260827_nfce_document_type_foundation.sql.
  SELECT * INTO v_row
  FROM public.fiscal_documents
  WHERE company_id = p_company_id
    AND sale_id = p_sale_id
    AND document_type = p_document_type
    AND environment = p_environment
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
      -- com lock, nunca insere uma segunda. Mesmo filtro de `environment`
      -- do SELECT inicial — sem ele, esta re-busca poderia devolver a
      -- linha de OUTRO ambiente por engano caso ela exista.
      SELECT * INTO v_row
      FROM public.fiscal_documents
      WHERE company_id = p_company_id
        AND sale_id = p_sale_id
        AND document_type = p_document_type
        AND environment = p_environment
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
    -- RISCO RESIDUAL #2 (fechado, herdado sem alteração): lease livre/
    -- expirada NÃO é suficiente aqui. Existe evidência de que uma
    -- transmissão HTTP real foi despachada sob o claim mais recente
    -- (rpc_begin_fiscal_transmission rodou) e não sabemos o resultado —
    -- força reconciliação incondicionalmente, não importa o valor de
    -- `status`.
    RETURN QUERY SELECT 'reconciliation_required'::text, v_row.id, v_row.status, v_row.provider_ref, v_row.number, v_row.series, v_row.access_key::text, v_row.authorization_protocol, v_row.status_sefaz, v_row.status_message, v_row.submission_error_code, v_row.submission_error_message, v_row.xml_path, v_row.danfe_path, v_row.submission_claim_token, v_row.submission_lease_until, v_row.submission_attempts, v_row.submission_started_at;
    RETURN;
  END IF;

  -- draft / validation_failed / submission_error / authorization_failed /
  -- cancellation_failed / pending-sem-transmissão-despachada, sem lease
  -- ativa e sem submission_started_at → nenhuma evidência de transmissão
  -- anterior → seguro reclamar direto.
  v_token := gen_random_uuid()::text;

  -- ATENÇÃO — ambiguidade de identificador (herdada, ver migration
  -- 20260826/20260827 pro relato completo do bug real encontrado em
  -- teste manual contra Postgres real): `RETURNS TABLE(...)` acima
  -- declara `id`, `status`, `submission_attempts` etc. como variáveis de
  -- saída visíveis em todo o corpo sob `plpgsql.variable_conflict =
  -- error` — por isso o alias `fd` qualifica especificamente `fd.id`
  -- (WHERE) e `fd.submission_attempts` (lado direito do SET).
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

-- Assinatura não mudou — GRANT/REVOKE já aplicados em
-- 20260827_nfce_document_type_foundation.sql continuam valendo
-- (CREATE OR REPLACE preserva privilégios da função existente). Reafirmado
-- aqui só por clareza/idempotência, sem efeito colateral.
REVOKE ALL ON FUNCTION public.rpc_claim_fiscal_emission(int, int, text, text, int, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.rpc_claim_fiscal_emission(int, int, text, text, int, text) TO service_role;

COMMIT;


-- =============================================================================
-- Smoke tests (rodar manualmente após a migration, opcional)
-- =============================================================================

-- 1) Confirma o novo índice com as 4 colunas certas.
SELECT indexdef FROM pg_indexes
WHERE schemaname = 'public' AND indexname = 'uq_fiscal_documents_sale_authorized';
-- Esperado: contém "(company_id, sale_id, document_type, environment)" e "WHERE (status = 'authorized'::text)"

-- 2) Confirma que a assinatura da função não mudou (mesmos 6 parâmetros).
SELECT pg_get_function_identity_arguments(oid) FROM pg_proc
WHERE proname = 'rpc_claim_fiscal_emission' AND pronamespace = 'public'::regnamespace;
-- Esperado: 1 linha só, mesma assinatura de antes (nenhuma versão duplicada)

-- 3) Confirma que nenhum dado existente violaria a garantia nova (deve
--    já ser verdade hoje pelo índice antigo, mas serve de dupla-checagem
--    pós-migration).
SELECT company_id, sale_id, document_type, environment, COUNT(*) AS autorizados
FROM public.fiscal_documents
WHERE status = 'authorized'
GROUP BY company_id, sale_id, document_type, environment
HAVING COUNT(*) > 1;
-- Esperado: 0 linhas


-- =============================================================================
-- ROLLBACK (rodar manualmente, só se necessário reverter)
-- =============================================================================
/*
BEGIN;

DROP INDEX IF EXISTS public.uq_fiscal_documents_sale_authorized;

CREATE UNIQUE INDEX IF NOT EXISTS uq_fiscal_documents_sale_authorized
  ON public.fiscal_documents (sale_id, document_type)
  WHERE status = 'authorized';
-- ATENÇÃO: se já existirem 2 linhas authorized pro mesmo (sale_id,
-- document_type) em ambientes diferentes nesse ponto (exatamente o que
-- esta migration passou a permitir), este CREATE UNIQUE INDEX vai
-- FALHAR — resolva manualmente (cancelar/arquivar uma das linhas) antes
-- de reverter.

-- Corpo da função sem o filtro de environment nos SELECTs — colar de
-- volta o corpo exato de 20260827_nfce_document_type_foundation.sql se
-- o rollback completo da RPC for necessário (não duplicado aqui de
-- propósito).

COMMIT;
*/
