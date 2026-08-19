-- =============================================================================
-- 20260824_fiscal_documents_audit_trail.sql
--
-- Fase Fiscal 2B, seção 10 do pedido — audit trail suficiente pra
-- futuramente substituir a Focus por integração direta com SEFAZ, sem
-- perder o histórico do que foi enviado/recebido.
--
-- Menor alteração de schema possível (instrução explícita: "evite criar
-- tabelas demais") — 4 colunas novas em `fiscal_documents`, nenhuma
-- tabela nova. `fiscal_documents` já tinha `provider_payload` (Fase 1,
-- pensado pra resposta bruta da Focus) — este arquivo só adiciona o que
-- faltava: o PAYLOAD ENVIADO (nunca registrado antes) e o CONTEXTO FISCAL
-- normalizado que gerou esse payload (pra auditoria/reconstrução futura,
-- independente da Focus).
--
--   request_payload         — o objeto `FocusNfePayload` exatamente como
--                              enviado em `POST /v2/nfe?ref=...`. Nunca
--                              contém segredo — `buildNfePayload` é puro e
--                              nunca recebe token/credencial como entrada,
--                              só dado fiscal (confirmado por leitura do
--                              código, não por sanitização defensiva).
--   fiscal_context_snapshot — o `FiscalDocumentContext` normalizado usado
--                              pra montar o payload (emitente/destinatário/
--                              itens/operação) — a peça que falta pra
--                              reconstruir “por que emitimos assim” sem
--                              depender da Focus ter guardado nada.
--   xml_path                 — `caminho_xml_nota_fiscal` da resposta Focus
--                              (URL/caminho do XML autorizado).
--   danfe_path                — `caminho_danfe` da resposta Focus.
--
-- NÃO adicionado (por instrução explícita — nunca persistir): token Focus,
-- Authorization header, PFX, senha do certificado, segredo criptográfico.
-- Nenhum desses aparece em `request_payload`/`fiscal_context_snapshot` por
-- construção (nem `buildNfePayload` nem `loadSaleFiscalContext` recebem ou
-- devolvem credencial).
--
-- Sobre XML/DANFE (seção 11 do pedido): `xml_path`/`danfe_path` guardam a
-- URL/caminho retornado pela Focus, não o conteúdo baixado — a
-- durabilidade dessa URL não está confirmada na documentação consultada
-- (ver relatório da fase, seção H). Baixar e arquivar o conteúdo em
-- storage próprio fica pra uma fase futura, só depois de confirmar isso
-- com uma emissão real.
-- =============================================================================

ALTER TABLE public.fiscal_documents
  ADD COLUMN IF NOT EXISTS request_payload         JSONB,
  ADD COLUMN IF NOT EXISTS fiscal_context_snapshot  JSONB,
  ADD COLUMN IF NOT EXISTS xml_path                 TEXT,
  ADD COLUMN IF NOT EXISTS danfe_path               TEXT;

COMMENT ON COLUMN public.fiscal_documents.provider_payload IS 'Resposta bruta da Focus (sanitizada — nunca deveria conter segredo, mas cautela na camada de aplicação antes do INSERT).';
COMMENT ON COLUMN public.fiscal_documents.request_payload IS 'Payload exatamente enviado a POST /v2/nfe?ref=... — nunca contém segredo (buildNfePayload é puro, só dado fiscal).';
COMMENT ON COLUMN public.fiscal_documents.fiscal_context_snapshot IS 'FiscalDocumentContext normalizado usado pra montar o payload — evidência pra auditoria/futura migração pra SEFAZ direto.';
COMMENT ON COLUMN public.fiscal_documents.xml_path IS 'caminho_xml_nota_fiscal retornado pela Focus quando autorizado — URL/caminho, não o conteúdo.';
COMMENT ON COLUMN public.fiscal_documents.danfe_path IS 'caminho_danfe retornado pela Focus quando autorizado — URL/caminho, não o conteúdo.';

-- =============================================================================
-- ROLLBACK
-- =============================================================================
/*
ALTER TABLE public.fiscal_documents
  DROP COLUMN IF EXISTS request_payload,
  DROP COLUMN IF EXISTS fiscal_context_snapshot,
  DROP COLUMN IF EXISTS xml_path,
  DROP COLUMN IF EXISTS danfe_path;
*/
