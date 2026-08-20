-- =============================================================================
-- 20260826_fiscal_emission_claim.sql
--
-- Lock/idempotência de concorrência da transmissão NF-e Focus — fase
-- seguinte à Fase Fiscal 3A. Fecha o race condition real identificado por
-- leitura direta de `submitNfeHomologacao.ts` (versão anterior a esta
-- migration): entre `getOrCreateFiscalDocument` devolver uma linha
-- `draft` e o `issueFocusNfe` (`POST /v2/nfe`) ser chamado, nada impedia
-- duas execuções concorrentes de passarem pelas mesmas checagens de
-- status e chegarem AMBAS ao POST — o único freio era o
-- UNIQUE(provider, provider_ref) no INSERT da linha, que não protege
-- contra duas transmissões concorrentes sobre uma linha JÁ existente.
--
-- ─── Desenho ─────────────────────────────────────────────────────────────
--
-- claim atômico curto (`rpc_claim_fiscal_emission`) → COMMIT → HTTP Focus
-- FORA de qualquer transação → persistência curta do resultado, guardada
-- por claim_token (`rpc_complete_fiscal_emission`). Nenhuma das duas
-- funções faz ou espera HTTP — cada uma é uma única execução PL/pgSQL,
-- comita e libera o lock assim que retorna. `SELECT ... FOR UPDATE` (não
-- SKIP LOCKED — aqui queremos serializar sobre UM documento específico,
-- nunca pular pra outro) só existe dentro dessas duas funções curtas,
-- nunca ao redor de uma chamada HTTP.
--
-- provider_ref continua determinística (`qarvon-{company_id}-{sale_id}-
-- nfe`, gerada em TS) — esta migration não muda nada sobre isso, só
-- adiciona o mecanismo de claim/lease em cima da mesma identidade.
--
-- ─── Schema adicionado a fiscal_documents ────────────────────────────────
--   submission_claim_token   TEXT         — token do claim mais recente
--                                            (imprevisível, gen_random_uuid).
--                                            Nunca zerado após uso — fica
--                                            como registro histórico de
--                                            qual claim originou o último
--                                            estado (auditoria).
--   submission_claimed_at    TIMESTAMPTZ  — quando esse claim foi obtido.
--   submission_lease_until   TIMESTAMPTZ  — até quando esse claim é válido
--                                            (lease). ATENÇÃO: desde o
--                                            fechamento do risco residual
--                                            #2 (ver bloco abaixo), a lease
--                                            SOZINHA não decide mais nada
--                                            sobre reclamar depois que
--                                            `submission_started_at` (ver
--                                            abaixo) existir — ela só
--                                            controla 'busy' vs. não-busy.
--   submission_attempts      INT NOT NULL DEFAULT 0 — quantas vezes um
--                                            claim foi concedido pra este
--                                            documento (observabilidade —
--                                            seção 15 do pedido).
--   submission_started_at    TIMESTAMPTZ  — NOVO (fechamento do risco
--                                            residual #2). Marca, de forma
--                                            atômica e guardada por
--                                            claim_token, o instante em que
--                                            a transmissão HTTP
--                                            (`POST /v2/nfe`) foi de fato
--                                            iniciada para o claim VIGENTE.
--                                            Ver bloco "risco residual #2"
--                                            abaixo pra semântica completa.
--
-- `issued_at` (já existente, Fase 1) continua com seu papel histórico:
-- "quando o POST mais recente foi de fato enviado", write-once por
-- resultado, nunca resetado por um claim novo — serve pra auditoria de
-- longo prazo do documento inteiro. `submission_started_at` é um campo
-- DIFERENTE, deliberadamente: é resetado a NULL toda vez que um NOVO claim
-- é concedido (ver rpc_claim_fiscal_emission abaixo) — seu único propósito
-- é ser o sinal de concorrência "o claim ATUAL já iniciou uma transmissão
-- HTTP ou não", nunca um registro histórico. Os dois campos coexistem sem
-- redundância: um é auditoria (nunca reseta), o outro é controle de
-- concorrência por tentativa (sempre reseta).
--
-- ─── Risco residual #2 (fechado nesta revisão) ───────────────────────────
--
-- Risco original (relatório da Fase 3B, seção G, item 2): se o `POST
-- /v2/nfe` demorar mais que a lease (60s) — por exemplo o cliente HTTP
-- (`httpClient.ts`) dá timeout em 15s mas a Focus JÁ recebeu a requisição
-- e continua processando — e uma segunda execução reclamar o mesmo
-- documento nesse meio-tempo, o design anterior (lease expirada + status
-- 'pending' → 'reconciliation_required' → consulta à Focus → 404
-- "não encontrado" → status vira 'submission_error', retentável)
-- confundia "a Focus ainda não recebeu a transmissão original" (falso
-- negativo possível, já que a consulta pode chegar antes do POST original
-- ser processado do lado da Focus) com "a transmissão original nunca
-- aconteceu". Isso podia liberar um SEGUNDO `POST /v2/nfe` real enquanto o
-- primeiro ainda estava genuinamente em voo — duas transmissões
-- concorrentes com a mesma `provider_ref`, exatamente o que o claim/lease
-- deveria impedir.
--
-- Correção: três estados agora são distinguidos explicitamente, não mais
-- dois:
--   1. claim adquirido       — `rpc_claim_fiscal_emission` decisão
--                               'claimed'; `submission_started_at` é
--                               resetado a NULL neste momento (linha
--                               "ainda não tentou transmitir nesta
--                               tentativa").
--   2. transmissão iniciada  — `rpc_begin_fiscal_transmission`, chamada
--                               pelo service IMEDIATAMENTE ANTES de
--                               `issueFocusNfe` (a chamada HTTP real),
--                               grava `submission_started_at = NOW()`
--                               atomicamente, guardada pelo claim_token
--                               vigente.
--   3. resultado/reconciliação — `rpc_complete_fiscal_emission` (resultado
--                               conhecido) ou `consultAndUpdateFiscalDocument`
--                               (reconciliação via consulta à Focus).
--
-- A regra nova, central, em `rpc_claim_fiscal_emission`:
--   `submission_started_at IS NOT NULL` → SEMPRE 'reconciliation_required',
--   incondicionalmente — não importa se a lease está ativa ou expirada, e
--   não importa o valor de `status`. Uma vez que sabemos que UM POST real
--   foi despachado pra Focus sob o claim vigente, a ÚNICA forma de saber
--   se é seguro tentar de novo é consultar a Focus pela mesma
--   `provider_ref` e receber uma confirmação inequívoca de ausência — a
--   lease expirar nunca mais é, sozinha, permissão pra reclamar. Isso NÃO
--   foi resolvido aumentando a lease (o pedido foi explícito em proibir
--   essa saída) — foi resolvido tornando a decisão independente da
--   duração da lease a partir do momento em que existe evidência de
--   despacho real.
--
-- Se `submission_started_at IS NULL` (nenhuma transmissão foi despachada
-- pelo claim mais recente — por exemplo: crash durante validação/montagem
-- do payload, ANTES de `rpc_begin_fiscal_transmission` ser chamado), não
-- há nenhuma evidência de transmissão anterior — reclamar direto continua
-- seguro (é exatamente o caso 1 do pedido: "não houver evidência de
-- transmissão anterior").
--
-- Quando a reconciliação (consulta à Focus) confirma inequivocamente que
-- a `provider_ref` não existe do lado da Focus, o service grava
-- status='submission_error' (retentável) E TAMBÉM limpa
-- `submission_started_at` NESSE MESMO INSTANTE — a MESMA `provider_ref`
-- determinística continua sendo usada em qualquer nova tentativa (nunca
-- muda). Este segundo ponto é essencial, não opcional: `rpc_claim_fiscal_
-- emission` só reseta `submission_started_at` quando CONCEDE um claim, e só
-- concede um claim quando `submission_started_at` já é NULL — se a
-- reconciliação não limpasse o campo, nenhum claim futuro jamais seria
-- concedido (toda tentativa cairia em `reconciliation_required` de novo,
-- mesmo já sabendo que é seguro reclamar — um laço sem saída). O mesmo
-- vale, simetricamente, pra qualquer outra conclusão DEFINITIVA de uma
-- consulta (autorizado/rejeitado/cancelado/erro de cancelamento) —
-- qualquer resultado que NÃO seja "ainda processando" (`pending`) limpa
-- `submission_started_at`; só `pending` (incerteza genuína, a transmissão
-- pode continuar em andamento do lado da Focus) o mantém.
--
-- ─── RPCs ─────────────────────────────────────────────────────────────────
--
-- rpc_claim_fiscal_emission(p_company_id, p_sale_id, p_provider_ref,
--   p_environment, p_lease_seconds DEFAULT 60)
--   Localiza ou cria atomicamente a linha (mesma lógica de
--   getOrCreateFiscalDocument, agora dentro da transação curta da função,
--   com FOR UPDATE serializando concorrência real), decide entre:
--     'already_authorized'      — status já é 'authorized', nunca reemite.
--     'already_cancelled'       — status já é 'cancelled', nunca reemite.
--     'busy'                    — outro claim tem lease ainda válido.
--     'reconciliation_required' — status='pending' com lease expirado ou
--                                  inexistente (resultado de uma tentativa
--                                  anterior é desconhecido) — nunca
--                                  reclama nem autoriza POST direto; quem
--                                  chamou precisa consultar a Focus
--                                  primeiro (seção 7 do pedido: "lease
--                                  expirou ≠ POST novamente").
--     'claimed'                 — concede o claim: grava claim_token novo,
--                                  claimed_at, lease_until, incrementa
--                                  attempts, e marca status='pending'
--                                  (unifica "claim ativo" com o mesmo
--                                  significado que 'pending' já tinha —
--                                  "tentativa em curso ou de resultado
--                                  desconhecido" — nunca dois conceitos
--                                  concorrentes pro mesmo estado).
--   'not_emittable' NÃO é uma decisão desta RPC — o motivo (ex.: venda
--   cancelled/returned) só é conhecido depois de carregar o contexto
--   fiscal completo (`loadSaleFiscalContext`/`validateFiscalReadiness`,
--   Fase 3A), informação que esta RPC não tem (só enxerga
--   `fiscal_documents`, nunca `sales`). Continua verificado no service,
--   depois de um claim bem-sucedido.
--
-- rpc_complete_fiscal_emission(p_fiscal_document_id, p_claim_token, ...)
--   Única forma de gravar um resultado (validation_failed/submission_error/
--   pending desconhecido/authorization_failed/authorized) depois de um
--   claim — SÓ escreve se `submission_claim_token` da linha ainda for
--   IGUAL ao token informado (seção 10 do pedido: proteção contra worker
--   antigo). Se um claim mais novo já substituiu o token (lease do
--   primeiro expirou e outra execução reclamou), o UPDATE não afeta
--   nenhuma linha — devolve conjunto vazio, e quem chamou trata isso como
--   "meu resultado foi superado, não sobrescrevo nada" (nunca um erro).
--   Duas categorias de campo, tratamento deliberadamente diferente:
--     - status/status_sefaz/status_message/erros/number/series/access_key/
--       protocol/xml_path/danfe_path: SEMPRE sobrescritos com o que foi
--       passado (mesmo NULL) — representam "o resultado da tentativa mais
--       recente", nunca deveriam carregar lixo de uma tentativa anterior
--       diferente (mesmo comportamento que `applyFocusResponse`/os catches
--       de erro já tinham antes desta migration, agora com o guard de
--       token).
--     - provider_payload/request_payload/fiscal_context_snapshot/
--       issued_at/authorized_at: COALESCE com o valor já existente —
--       campos "grava uma vez por tentativa", que o service pode
--       legitimamente omitir numa segunda chamada de conclusão dentro do
--       MESMO claim (ex.: primeiro grava request_payload/issued_at ao
--       persistir a intenção, depois grava o resultado final sem precisar
--       reenviar o payload inteiro) sem apagar o que já foi gravado.
--   SEMPRE libera `submission_lease_until` (→ NULL) ao concluir, não
--   importa o status resultante — o propósito da lease é "alguém está
--   trabalhando NESTE MOMENTO", que deixa de ser verdade assim que a
--   conclusão é gravada (mesmo pra `pending`/timeout, onde o PRÓXIMO claim
--   precisa ver `reconciliation_required`, não `busy`, já que ninguém
--   mais está de fato trabalhando). `submission_claim_token`/
--   `submission_claimed_at` continuam intocados (histórico).
--
-- A reconciliação (`consultAndUpdateFiscalDocument`, consulta pura
-- `GET /v2/nfe/{ref}`) continua gravando SEM exigir claim_token — é
-- leitura da verdade da Focus, determinística por ref; mesmo que uma
-- execução "antiga" grave o resultado de uma consulta, é a MESMA verdade
-- que qualquer outra consulta chegaria — não há "worker errado
-- sobrescrevendo", só "verdade confirmada de novo".
--
-- ─── Constraints preservadas ──────────────────────────────────────────────
-- UNIQUE(provider, provider_ref), UNIQUE(access_key) WHERE NOT NULL,
-- UNIQUE(sale_id, document_type) WHERE status='authorized' — nenhuma foi
-- alterada ou removida. O claim COMPLEMENTA essas barreiras (evita a
-- corrida ANTES de qualquer INSERT/POST); as constraints continuam sendo
-- a última linha de defesa se algo no meio do caminho falhar.
-- =============================================================================

-- ─── 1. Schema ──────────────────────────────────────────────────────────────

ALTER TABLE public.fiscal_documents
  ADD COLUMN IF NOT EXISTS submission_claim_token   TEXT,
  ADD COLUMN IF NOT EXISTS submission_claimed_at    TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS submission_lease_until   TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS submission_attempts      INT NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS submission_started_at    TIMESTAMPTZ;

COMMENT ON COLUMN public.fiscal_documents.submission_claim_token IS 'Token do claim mais recente (gen_random_uuid) — nunca zerado após uso, fica como registro histórico. Ver rpc_claim_fiscal_emission/rpc_complete_fiscal_emission.';
COMMENT ON COLUMN public.fiscal_documents.submission_claimed_at IS 'Quando o claim mais recente foi concedido.';
COMMENT ON COLUMN public.fiscal_documents.submission_lease_until IS 'Até quando o claim mais recente é válido (controla apenas "busy"). Depois que submission_started_at existir para o claim vigente, a lease expirar NÃO autoriza retransmissão direta — só reconciliação.';
COMMENT ON COLUMN public.fiscal_documents.submission_attempts IS 'Quantas vezes um claim foi concedido pra este documento — observabilidade, nunca usado pra lógica de negócio além de exposição informativa.';
COMMENT ON COLUMN public.fiscal_documents.submission_started_at IS 'Quando o POST /v2/nfe foi de fato iniciado sob o claim vigente (rpc_begin_fiscal_transmission). Resetado a NULL a cada novo claim concedido. NOT NULL aqui força reconciliation_required incondicional, independente da lease — risco residual #2 (Fase 3B).';

-- ─── 2. rpc_claim_fiscal_emission ────────────────────────────────────────────

-- PRÉ-REQUISITO DE SCHEMA — esta função pressupõe o schema fiscal COMPLETO,
-- incluindo `xml_path`/`danfe_path`/`request_payload`/`fiscal_context_snapshot`,
-- todos adicionados por `20260824_fiscal_documents_audit_trail.sql` (Fase
-- Fiscal 2B). Um teste manual anterior encontrou "record v_row has no field
-- xml_path" contra um banco de teste que estava sem essa migration aplicada
-- (drift de schema do AMBIENTE, não um bug de código) — chegou a existir
-- aqui uma adaptação temporária (`NULL::text` no lugar de
-- `v_row.xml_path`/`v_row.danfe_path`) só pra contornar aquele banco
-- específico; foi revertida deliberadamente. A função abaixo exige o
-- schema completo — rode `20260824_fiscal_documents_audit_trail.sql` (ou o
-- patch idempotente equivalente) ANTES de aplicar esta função em qualquer
-- banco que ainda não tenha essas 4 colunas.
CREATE OR REPLACE FUNCTION public.rpc_claim_fiscal_emission(
  p_company_id    int,
  p_sale_id       int,
  p_provider_ref  text,
  p_environment   text,
  p_lease_seconds int DEFAULT 60
)
-- Auditoria de tipos (bug real encontrado em smoke test: "structure of
-- query does not match function result type ... character(44) does not
-- match expected type text in column 7") — os 18 campos abaixo conferidos
-- 1:1 contra o tipo REAL de fiscal_documents:
--   id bigint            ↔ id BIGSERIAL (bigint)                    ok
--   status/provider_ref/number/series/authorization_protocol/
--   status_sefaz/status_message/submission_error_code/
--   submission_error_message/xml_path/danfe_path/
--   submission_claim_token text ↔ TEXT (todas)                      ok
--   access_key text      ↔ access_key CHAR(44)                      MISMATCH
--     `RETURN QUERY` exige tipo IDÊNTICO ao de RETURNS TABLE, não faz cast
--     implícito bpchar→text como um SELECT solto faria — por isso
--     `v_row.access_key::text` no corpo (nunca mudamos a coluna real nem a
--     assinatura da função, só o valor devolvido).
--   submission_lease_until/submission_started_at timestamptz ↔
--     TIMESTAMPTZ (ambas)                                           ok
--   submission_attempts int ↔ INT NOT NULL DEFAULT 0                ok
--   decision text — não é coluna de tabela, sempre literal já com ::text ok
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
  SELECT * INTO v_row
  FROM public.fiscal_documents
  WHERE company_id = p_company_id AND sale_id = p_sale_id AND document_type = 'nfe'
  ORDER BY created_at DESC
  LIMIT 1
  FOR UPDATE;

  IF NOT FOUND THEN
    BEGIN
      INSERT INTO public.fiscal_documents (company_id, sale_id, document_type, provider, environment, provider_ref, status)
      VALUES (p_company_id, p_sale_id, 'nfe', 'focus_nfe', p_environment, p_provider_ref, 'draft')
      RETURNING * INTO v_row;
    EXCEPTION WHEN unique_violation THEN
      -- Corrida perdida no INSERT (outra transação criou a linha entre o
      -- SELECT acima não encontrar nada e este INSERT rodar) — re-busca
      -- com lock, nunca insere uma segunda.
      SELECT * INTO v_row
      FROM public.fiscal_documents
      WHERE company_id = p_company_id AND sale_id = p_sale_id AND document_type = 'nfe'
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
  -- `fd.id` (WHERE) e `fd.submission_attempts` (lado direito do SET) — as
  -- duas únicas referências desta função que eram genuinamente ambíguas;
  -- todo o resto da função (SELECTs por company_id/sale_id/document_type/
  -- created_at, o INSERT, e todos os `v_row.campo` nos RETURN QUERY) já
  -- era seguro sem qualificação, verificado nesta mesma revisão.
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

REVOKE ALL ON FUNCTION public.rpc_claim_fiscal_emission(int, int, text, text, int) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.rpc_claim_fiscal_emission(int, int, text, text, int) TO service_role;

-- ─── 3. rpc_complete_fiscal_emission ─────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.rpc_complete_fiscal_emission(
  p_fiscal_document_id        bigint,
  p_claim_token                text,
  p_status                      text,
  p_status_sefaz                 text        DEFAULT NULL,
  p_status_message                 text        DEFAULT NULL,
  p_submission_error_code            text        DEFAULT NULL,
  p_submission_error_message           text        DEFAULT NULL,
  p_number                               text        DEFAULT NULL,
  p_series                                text        DEFAULT NULL,
  p_access_key                             text        DEFAULT NULL,
  p_authorization_protocol                   text        DEFAULT NULL,
  p_xml_path                                   text        DEFAULT NULL,
  p_danfe_path                                   text        DEFAULT NULL,
  p_provider_payload                               jsonb       DEFAULT NULL,
  p_request_payload                                  jsonb       DEFAULT NULL,
  p_fiscal_context_snapshot                            jsonb       DEFAULT NULL,
  p_issued_at                                            timestamptz DEFAULT NULL,
  p_authorized_at                                          timestamptz DEFAULT NULL
)
RETURNS SETOF public.fiscal_documents
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  -- Só afeta a linha se o claim_token ainda for o vigente — proteção
  -- contra worker antigo (seção 10 do pedido). Ver comentário completo no
  -- topo do arquivo sobre a distinção "sobrescreve sempre" vs. "COALESCE".
  --
  -- `submission_lease_until = NULL`: SEMPRE libera a lease ao concluir,
  -- não importa pra qual status — o propósito da lease é sinalizar
  -- "alguém está trabalhando NESTE EXATO MOMENTO", e isso deixa de ser
  -- verdade assim que a conclusão é gravada, mesmo quando o resultado
  -- ainda é `pending` (timeout/rede — resultado desconhecido). Sem isso,
  -- um retry logo em seguida veria a lease antiga ainda "válida" (não
  -- expirada por tempo) e devolveria `busy` incorretamente pra um
  -- documento que já não tem ninguém trabalhando nele. Quando o status
  -- fica `pending`, a ausência de lease ativa faz a PRÓXIMA chamada cair
  -- em `reconciliation_required` (nunca reemite direto) — exatamente o
  -- comportamento pedido. `submission_claim_token`/`submission_claimed_at`
  -- NÃO são limpos — ficam como registro histórico de qual claim originou
  -- o último resultado (auditoria, seção 15 do pedido).
  --
  -- `submission_started_at`: limpo (→ NULL) SEMPRE QUE `p_status` NÃO for
  -- 'pending' — fechamento do risco residual #2. Um `p_status` diferente de
  -- 'pending' aqui significa que TEMOS uma resposta definitiva e conhecida
  -- da Focus pra ESTA tentativa (autorizado, rejeição síncrona 400/422 —
  -- `submission_error` —, erro_autorizacao, etc.) — a incerteza que
  -- `submission_started_at` representava ("um POST real está em voo, não
  -- sabemos o resultado") deixou de existir, então liberar o campo é
  -- seguro e necessário: sem isso, nenhum claim futuro seria concedido
  -- (rpc_claim_fiscal_emission só concede quando `submission_started_at`
  -- já é NULL), mesmo já sabendo com certeza que é seguro reclamar — um
  -- laço sem saída. Só quando `p_status = 'pending'` (timeout/rede — a
  -- Focus pode genuinamente ainda estar processando um POST que chegou) o
  -- campo é preservado, mantendo a proteção do risco residual #2 ativa até
  -- uma reconciliação de verdade resolver a incerteza.
  RETURN QUERY
  UPDATE public.fiscal_documents
  SET status                     = p_status,
      status_sefaz                = p_status_sefaz,
      status_message                = p_status_message,
      submission_error_code           = p_submission_error_code,
      submission_error_message          = p_submission_error_message,
      number                               = p_number,
      series                                 = p_series,
      access_key                              = p_access_key,
      authorization_protocol                    = p_authorization_protocol,
      xml_path                                    = p_xml_path,
      danfe_path                                    = p_danfe_path,
      provider_payload                                = COALESCE(p_provider_payload, provider_payload),
      request_payload                                   = COALESCE(p_request_payload, request_payload),
      fiscal_context_snapshot                             = COALESCE(p_fiscal_context_snapshot, fiscal_context_snapshot),
      issued_at                                             = COALESCE(p_issued_at, issued_at),
      authorized_at                                           = COALESCE(p_authorized_at, authorized_at),
      submission_lease_until                                    = NULL,
      submission_started_at                                     = CASE WHEN p_status = 'pending' THEN submission_started_at ELSE NULL END
  WHERE id = p_fiscal_document_id
    AND submission_claim_token = p_claim_token
  RETURNING *;
END;
$$;

REVOKE ALL ON FUNCTION public.rpc_complete_fiscal_emission(bigint, text, text, text, text, text, text, text, text, text, text, text, text, jsonb, jsonb, jsonb, timestamptz, timestamptz) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.rpc_complete_fiscal_emission(bigint, text, text, text, text, text, text, text, text, text, text, text, text, jsonb, jsonb, jsonb, timestamptz, timestamptz) TO service_role;

-- ─── 4. rpc_begin_fiscal_transmission (fechamento do risco residual #2) ─────
--
-- Chamada pelo service IMEDIATAMENTE ANTES de `issueFocusNfe`
-- (`POST /v2/nfe`), guardada pelo claim_token vigente — marca
-- atomicamente que a transmissão HTTP real está prestes a começar.
-- Deliberadamente NÃO toca `status` nem `submission_lease_until`: não é
-- uma conclusão (o resultado ainda é desconhecido), é só o registro de
-- que uma tentativa de despacho está em curso. Ver bloco "Risco residual
-- #2" no topo do arquivo para a semântica completa.
--
-- Aproveitada também pra persistir `request_payload`/
-- `fiscal_context_snapshot` no mesmo instante (substituindo a antiga
-- prática de gravar isso via `rpc_complete_fiscal_emission` com
-- status='pending' antes do POST — aquela chamada tinha o efeito colateral
-- indesejado de já liberar a lease antes do POST sequer começar, reduzindo
-- a proteção da lease a zero durante a chamada HTTP).
--
-- Guard: `id` + `submission_claim_token` + `submission_lease_until > NOW()`
-- + `submission_started_at IS NULL`. Zero linhas = quem chamou não tem mais
-- (ou nunca teve, sob este token, neste instante) o direito de iniciar uma
-- transmissão — quem chamou trata isso como "não sou mais dono desta
-- tentativa, não chamo a Focus".
--
-- ─── Auditoria — race condition real encontrada em Postgres real ─────────
--
-- Achado (evidência real): `submission_lease_until = 02:40:01`,
-- `rpc_begin_fiscal_transmission` executou às `02:40:21` (20s depois de a
-- lease expirar) e teve SUCESSO — o guard antigo só checava
-- `id = p_fiscal_document_id AND submission_claim_token = p_claim_token`,
-- sem checar lease nem `submission_started_at`.
--
-- Análise de por que isso é um problema mesmo sem produzir, sozinho, um
-- segundo `POST /v2/nfe` através dos caminhos automatizados atuais:
--   `submission_claim_token` só pode conter UM valor por vez na linha —
--   `rpc_claim_fiscal_emission` sempre gera um token novo
--   (`gen_random_uuid()`) ao conceder um claim, e o `UPDATE ... WHERE
--   fd.id = v_row.id` que grava esse token novo é serializado pelo
--   locking normal de linha do Postgres (READ COMMITTED: uma segunda
--   transação que tente `UPDATE`/`SELECT ... FOR UPDATE` a MESMA linha
--   espera a primeira commitar, depois REAVALIA seu WHERE contra o estado
--   já commitado). Por isso, sob os fluxos automatizados de
--   `submitNfeHomologacao.ts`, um worker "antigo" chamando `begin` com um
--   token já substituído por um claim novo SEMPRE falhava por
--   `submission_claim_token <> p_claim_token` — não por causa da lease.
--   Confirmado: não existe, nos caminhos automatizados atuais, uma
--   sequência que produza DOIS `POST /v2/nfe` reais através apenas da
--   ausência do check de lease em `begin`.
--
--   O problema real é semântico/operacional, não uma corrida de dois
--   `POST`: a lease existe pra dizer "depois deste instante, considere
--   este claim abandonado". Sem o check em `begin`, um worker
--   suficientemente lento (crash parcial, GC/thread stall, debugger
--   pausado, contêiner sofrendo throttling) podia iniciar uma transmissão
--   `submission_lease_until` já vencida — MUITO tempo depois de o sistema
--   (ou um operador olhando pra lease expirada) já ter considerado esse
--   claim morto. Isso quebra a garantia que `submission_started_at` deveria
--   representar ("uma transmissão real está genuinamente em andamento
--   AGORA, dentro da janela em que alguém prometeu estar cuidando dela") e
--   abre espaço pra intervenção manual/operacional colidir com um worker
--   "zumbi" que ninguém mais espera que ainda esteja vivo.
--
-- Correção: os 4 predicados abaixo, todos exigidos (AND):
--   `fd.id = p_fiscal_document_id`             — o documento certo.
--   `fd.submission_claim_token = p_claim_token` — o dono certo (inalterado).
--   `fd.submission_lease_until > NOW()`         — NOVO: a lease AINDA
--                                                  precisa estar ativa no
--                                                  instante exato do begin
--                                                  — reafirma "alguém
--                                                  prometeu estar
--                                                  trabalhando nisto
--                                                  AGORA", não só "alguém
--                                                  tinha o token em algum
--                                                  momento do passado".
--   `fd.submission_started_at IS NULL`          — NOVO: só a PRIMEIRA
--                                                  chamada de begin sob um
--                                                  claim pode ter efeito —
--                                                  uma segunda chamada
--                                                  (retry de rede na
--                                                  própria chamada RPC,
--                                                  bug do chamador) com o
--                                                  MESMO token não
--                                                  reabre/reafirma nada,
--                                                  devolve zero linhas.
--
-- Por que isso NÃO cria deadlock: é uma única instrução `UPDATE` sobre UMA
-- linha, mesmo padrão de locking de `rpc_claim_fiscal_emission`/
-- `rpc_complete_fiscal_emission` (lock de linha adquirido e liberado
-- dentro da mesma instrução/transação curta, nunca held através de HTTP).
-- Adicionar predicados ao WHERE muda QUAIS linhas casam, não a ordem ou o
-- conjunto de tabelas/locks adquiridos — nenhum lock novo, nenhuma tabela
-- nova, nenhuma dependência circular introduzida.
--
-- Por que isso NÃO impede uma conclusão legítima: `rpc_complete_fiscal_
-- emission` (acima) NUNCA checou lease — só `id` + `submission_claim_token`
-- — e continua exatamente assim, sem nenhuma alteração nesta revisão. Uma
-- transmissão legitimamente iniciada (begin bem-sucedido enquanto a lease
-- ainda estava ativa) pode ter sua resposta da Focus persistida por
-- `rpc_complete_fiscal_emission` MESMO que a lease tenha expirado
-- DEPOIS do begin e ANTES da resposta chegar — exatamente o comportamento
-- pedido ("se o claim_token ainda é o vigente, o worker deve conseguir
-- persistir o resultado"). `submitNfeHomologacao.ts` também não precisa de
-- nenhuma mudança: já tratava "begin devolveu zero linhas" como "aborta,
-- nunca chama a Focus, devolve o estado atual" (`if (!beginRow) { ... }`)
-- — os dois motivos NOVOS de zero linhas (lease vencida,
-- submission_started_at já setado) caem no MESMO tratamento seguro que já
-- existia pro motivo antigo (token superado).
CREATE OR REPLACE FUNCTION public.rpc_begin_fiscal_transmission(
  p_fiscal_document_id       bigint,
  p_claim_token              text,
  p_request_payload          jsonb DEFAULT NULL,
  p_fiscal_context_snapshot  jsonb DEFAULT NULL
)
RETURNS SETOF public.fiscal_documents
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  RETURN QUERY
  UPDATE public.fiscal_documents AS fd
  SET submission_started_at    = NOW(),
      issued_at                = NOW(),
      request_payload          = COALESCE(p_request_payload, request_payload),
      fiscal_context_snapshot  = COALESCE(p_fiscal_context_snapshot, fiscal_context_snapshot)
  WHERE fd.id = p_fiscal_document_id
    AND fd.submission_claim_token = p_claim_token
    AND fd.submission_lease_until > NOW()
    AND fd.submission_started_at IS NULL
  RETURNING fd.*;
END;
$$;

REVOKE ALL ON FUNCTION public.rpc_begin_fiscal_transmission(bigint, text, jsonb, jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.rpc_begin_fiscal_transmission(bigint, text, jsonb, jsonb) TO service_role;

-- =============================================================================
-- Smoke tests
-- =============================================================================

SELECT column_name FROM information_schema.columns
WHERE table_schema = 'public' AND table_name = 'fiscal_documents' AND column_name = 'submission_claim_token';
-- Esperado: 1 linha

SELECT column_name FROM information_schema.columns
WHERE table_schema = 'public' AND table_name = 'fiscal_documents' AND column_name = 'submission_started_at';
-- Esperado: 1 linha

SELECT proname FROM pg_proc WHERE proname IN ('rpc_claim_fiscal_emission', 'rpc_complete_fiscal_emission', 'rpc_begin_fiscal_transmission');
-- Esperado: 3 linhas

-- =============================================================================
-- ROLLBACK
-- =============================================================================
/*
DROP FUNCTION IF EXISTS public.rpc_begin_fiscal_transmission(bigint, text, jsonb, jsonb);
DROP FUNCTION IF EXISTS public.rpc_complete_fiscal_emission(bigint, text, text, text, text, text, text, text, text, text, text, text, text, jsonb, jsonb, jsonb, timestamptz, timestamptz);
DROP FUNCTION IF EXISTS public.rpc_claim_fiscal_emission(int, int, text, text, int);

ALTER TABLE public.fiscal_documents
  DROP COLUMN IF EXISTS submission_claim_token,
  DROP COLUMN IF EXISTS submission_claimed_at,
  DROP COLUMN IF EXISTS submission_lease_until,
  DROP COLUMN IF EXISTS submission_started_at,
  DROP COLUMN IF EXISTS submission_attempts;
*/
-- =============================================================================
-- FIM DA MIGRATION
-- =============================================================================
