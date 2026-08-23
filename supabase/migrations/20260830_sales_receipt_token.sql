-- Comprovante não fiscal / trocas — identificador público seguro da venda.
--
-- Por quê: auditoria confirmou que `sale_number` é gerado por
-- `generate_sale_number()` (000_schema_completo.sql:714) como
-- 'SNT-' || YYYYMMDD || '-' || contador sequencial do dia — sequencial e
-- adivinhável (enumerar SNT-20260823-0001, -0002, -0003... encontra vendas
-- reais). Não pode ser usado como chave de segurança para uma rota pública
-- de verificação de comprovante. Nenhum campo existente hoje em `sales`
-- cumpre esse papel — grep confirma que não há nenhuma coluna do tipo
-- token/uuid público em `sales` antes desta migration.
--
-- Solução: `sales.receipt_token`, UUID v4 (122 bits aleatórios,
-- `gen_random_uuid()` — não sequencial, não derivável de `id`/`sale_number`),
-- único, gerado automaticamente em toda venda nova (DEFAULT na coluna — não
-- exige nenhuma mudança em `rpc_create_sale` nem em nenhum outro caminho de
-- INSERT em `sales`) e imutável após criado (trigger abaixo).
--
-- Escopo desta migration: SOMENTE a coluna `sales.receipt_token` e sua
-- proteção. Não toca em estoque, financeiro, pricing, endereço/snapshot
-- (Fase 5C), nem em nenhuma RPC (`rpc_create_sale`, `rpc_cancel_sale`,
-- `rpc_return_sale`, `rpc_process_exchange` — nenhuma delas é alterada
-- aqui). Não mexe em fiscal/Focus/SEFAZ.
--
-- Idempotente: ADD COLUMN IF NOT EXISTS, UPDATE só preenche NULLs (seguro
-- rodar de novo — depois da primeira aplicação não sobra nenhum NULL para
-- atualizar), constraint/trigger com checagem IF NOT EXISTS/CREATE OR
-- REPLACE. Reversível: ver rollback no fim do arquivo (comentado, não
-- executado).

-- Checagem CORRIGIDA nesta revisão: a primeira versão checava
-- especificamente `to_regprocedure('public.gen_random_uuid()')` — errado,
-- porque gen_random_uuid() normalmente NÃO vive no schema `public`. Em
-- Postgres 13+ (qualquer projeto Supabase atual) a função é nativa do
-- núcleo, em `pg_catalog` — sem precisar de nenhuma extensão. Se vier de
-- `pgcrypto` em vez do núcleo, a convenção do Supabase é instalar a
-- extensão no schema `extensions`, não em `public`. `pg_function_is_visible`
-- é a checagem certa aqui: confirma que a função resolve SEM qualificar
-- schema (exatamente como é chamada mais abaixo, em `gen_random_uuid()`
-- sem prefixo), não importa em qual schema ela realmente esteja.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_proc p
    WHERE p.proname = 'gen_random_uuid'
      AND pg_function_is_visible(p.oid)
  ) THEN
    RAISE EXCEPTION
      'gen_random_uuid() não resolve no search_path atual deste banco. Isso é incomum em Postgres 13+/Supabase — confirme com "SHOW search_path;" e "SELECT gen_random_uuid();" antes de investigar extensão pgcrypto ausente.';
  END IF;
END $$;

-- ─── Passo 1 — coluna, ainda nullable (evita travar em NOT NULL antes do backfill) ──
ALTER TABLE public.sales
  ADD COLUMN IF NOT EXISTS receipt_token uuid;

-- ─── Passo 2 — backfill das vendas históricas ────────────────────────────────
-- SOMENTE preenche receipt_token; nenhuma outra coluna de `sales` é tocada —
-- não altera status, valores, estoque ou financeiro de nenhuma venda.
-- Idempotente: WHERE receipt_token IS NULL — rodar de novo depois da primeira
-- aplicação não faz nada (não sobra nenhuma linha NULL).
UPDATE public.sales
SET receipt_token = gen_random_uuid()
WHERE receipt_token IS NULL;

-- ─── Passo 3 — NOT NULL + DEFAULT para vendas futuras ────────────────────────
-- DEFAULT aqui é o que garante que toda venda nova (via rpc_create_sale ou
-- qualquer outro INSERT futuro em sales) recebe token automaticamente, sem
-- precisar tocar em nenhuma RPC.
ALTER TABLE public.sales
  ALTER COLUMN receipt_token SET NOT NULL;

ALTER TABLE public.sales
  ALTER COLUMN receipt_token SET DEFAULT gen_random_uuid();

-- ─── Passo 4 — UNIQUE ─────────────────────────────────────────────────────────
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'sales_receipt_token_key'
  ) THEN
    ALTER TABLE public.sales
      ADD CONSTRAINT sales_receipt_token_key UNIQUE (receipt_token);
  END IF;
END $$;

-- ─── Passo 5 — imutabilidade ──────────────────────────────────────────────────
-- Nenhum caminho de aplicação hoje escreve em receipt_token depois do INSERT
-- (grep confirma), mas o requisito é "imutável após criação" — reforçado
-- aqui em nível de banco, não só por convenção de código, mesmo padrão de
-- defesa em profundidade já usado nesta fase para outras invariantes
-- (CHECK constraints de formato em sale_recipients/customer_addresses).
-- O WHEN abaixo garante que a trigger só dispara quando receipt_token de
-- fato muda — não interfere em nenhum outro UPDATE de sales (status,
-- totais, cancelamento, devolução etc.), inclusive nenhuma das RPCs
-- existentes precisa mudar.
CREATE OR REPLACE FUNCTION public.fn_prevent_receipt_token_change()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'sales.receipt_token é imutável e não pode ser alterado após a criação.'
    USING ERRCODE = 'P0001';
END;
$$;

DROP TRIGGER IF EXISTS trg_prevent_receipt_token_change ON public.sales;

CREATE TRIGGER trg_prevent_receipt_token_change
  BEFORE UPDATE ON public.sales
  FOR EACH ROW
  WHEN (OLD.receipt_token IS DISTINCT FROM NEW.receipt_token)
  EXECUTE FUNCTION public.fn_prevent_receipt_token_change();

COMMENT ON COLUMN public.sales.receipt_token IS
  'Identificador público, aleatório e imutável da venda — usado exclusivamente pela rota de comprovante não fiscal (/comprovante/<token>) para localizar a venda sem expor sale_id/sale_number (sequencial, adivinhável). Nunca reutilizar sale_id/sale_number como chave de uma rota pública.';

-- =============================================================================
-- Rollback (não executado — referência caso seja necessário reverter):
--
--   DROP TRIGGER IF EXISTS trg_prevent_receipt_token_change ON public.sales;
--   DROP FUNCTION IF EXISTS public.fn_prevent_receipt_token_change();
--   ALTER TABLE public.sales DROP CONSTRAINT IF EXISTS sales_receipt_token_key;
--   ALTER TABLE public.sales ALTER COLUMN receipt_token DROP DEFAULT;
--   ALTER TABLE public.sales ALTER COLUMN receipt_token DROP NOT NULL;
--   ALTER TABLE public.sales DROP COLUMN IF EXISTS receipt_token;
--
-- Seguro em qualquer momento — nenhuma outra tabela referencia receipt_token
-- via FK, e a rota /comprovante/<token> simplesmente para de resolver
-- qualquer token (comportamento igual a "recurso não encontrado").
-- =============================================================================
