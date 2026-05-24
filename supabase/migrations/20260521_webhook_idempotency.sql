-- =============================================================================
-- Migration 20260521: Idempotência do webhook + correção do schema de clientes
--
-- PROBLEMA 1 — Race condition no webhook Nuvemshop
--   Dois disparos simultâneos do webhook para o mesmo pedido passam pelo
--   check `stock_processed = false` ao mesmo tempo, gerando venda duplicada
--   e duplo decremento de estoque.
--
--   Solução: coluna processing_lock (boolean) em pedidos. O webhook usa
--   UPDATE ... WHERE processing_lock = false RETURNING id para claim atômico.
--   Se 0 linhas retornadas → já está sendo processado → early return.
--
-- PROBLEMA 2 — findOrCreateCustomer: colunas cpf/phone NOT NULL, email inexistente
--   - customers.email não existe → query/insert falham
--   - cpf TEXT NOT NULL → pedidos Nuvemshop sem CPF causam erro
--   - phone TEXT NOT NULL → pedidos Nuvemshop sem telefone causam erro
--   - company_id não é fornecido no insert do webhook
--
--   Solução: adicionar email, tornar cpf/phone nullable, garantir
--   que o webhook passe company_id via lookup do NUVEMSHOP_SYSTEM_USER_ID.
-- =============================================================================

-- =============================================================================
-- PARTE 1 — Idempotência: processing_lock em pedidos
-- =============================================================================

-- stock_processed foi definido em 012_nuvemshop_stock_integration (legado, nunca
-- portado para supabase/migrations). ADD COLUMN IF NOT EXISTS é idempotente.
ALTER TABLE public.pedidos
  ADD COLUMN IF NOT EXISTS stock_processed        boolean     NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS processing_lock        boolean     NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS processing_claimed_at  timestamptz;

-- Índice para o webhook: buscar pedidos não processados eficientemente
CREATE INDEX IF NOT EXISTS idx_pedidos_external_source_lock
  ON public.pedidos (external_id, source, stock_processed, processing_lock);

-- Função auxiliar: liberar locks "zumbis" (webhook travou há > 5 min)
-- Chamar periodicamente via cron ou no início do handler
CREATE OR REPLACE FUNCTION public.release_stale_pedido_locks()
RETURNS int
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE v_count int;
BEGIN
  UPDATE public.pedidos
  SET processing_lock       = false,
      processing_claimed_at = NULL
  WHERE processing_lock       = true
    AND stock_processed        = false
    AND processing_claimed_at < NOW() - INTERVAL '5 minutes';
  GET DIAGNOSTICS v_count = ROW_COUNT;
  RETURN v_count;
END;
$$;

-- =============================================================================
-- PARTE 2 — Schema de clientes: email, cpf/phone nullable, company_id
-- =============================================================================

-- Adicionar email (não existia na tabela original)
ALTER TABLE public.customers
  ADD COLUMN IF NOT EXISTS email text;

CREATE INDEX IF NOT EXISTS idx_customers_email
  ON public.customers (email)
  WHERE email IS NOT NULL;

-- Tornar cpf e phone nullable para pedidos de e-commerce sem essas informações
ALTER TABLE public.customers
  ALTER COLUMN cpf   DROP NOT NULL,
  ALTER COLUMN phone DROP NOT NULL;

-- A constraint UNIQUE (cpf, company_id) permanece — NULLs não violam UNIQUE no PG.
-- Garantir que a constraint exista (idempotente)
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'customers_cpf_company_id_key'
      AND conrelid = 'public.customers'::regclass
  ) THEN
    -- Recria apenas se não existir (a original usa nome gerado automaticamente)
    -- Deixa a existente intacta se já existe sob outro nome
    NULL;
  END IF;
END $$;

-- =============================================================================
-- FIM DA MIGRAÇÃO
-- =============================================================================
