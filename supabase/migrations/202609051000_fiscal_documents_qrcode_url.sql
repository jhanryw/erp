-- Fase Fiscal 7 — persiste o QR Code real da NFC-e (campo `qrcode_url` já
-- retornado pela Focus na autorização, hoje só soterrado dentro de
-- `provider_payload` JSONB — nunca extraído pra coluna própria, confirmado
-- por auditoria em src/services/fiscal/submitNfceHomologacao.ts).
--
-- Aditiva, idempotente, sem lock significativo: ADD COLUMN nullable sem
-- DEFAULT é operação de metadado em Postgres 11+, mesmo com a tabela já
-- populada. Nenhum código de aplicação lê/escreve esta coluna ainda —
-- isso é um patch de código separado, só depois de confirmada a aplicação
-- desta migration no banco real (Supabase self-hosted).

ALTER TABLE public.fiscal_documents
  ADD COLUMN IF NOT EXISTS qrcode_url TEXT;

COMMENT ON COLUMN public.fiscal_documents.qrcode_url IS
  'URL de conteúdo do QR Code fiscal retornada pela Focus na autorização (campo "qrcode_url" da resposta) — usada pra renderizar o DANFE NFC-e. Nunca construída localmente a partir de sale_id/UUID interno.';
