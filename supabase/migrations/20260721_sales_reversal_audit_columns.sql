-- =============================================================================
-- 20260721_sales_reversal_audit_columns.sql
--
-- Financeiro 2.1 — Estabilidade de competência do DRE (1/3)
--
-- Adiciona colunas de auditoria de cancelamento/devolução em sales.
-- Puramente aditivo — nenhuma RPC ou view depende delas ainda nesta migration.
-- =============================================================================

ALTER TABLE public.sales
  ADD COLUMN IF NOT EXISTS cancelled_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS cancelled_by UUID REFERENCES public.users(id),
  ADD COLUMN IF NOT EXISTS returned_at  TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS returned_by  UUID REFERENCES public.users(id);

COMMENT ON COLUMN public.sales.cancelled_at IS
  'Momento exato do cancelamento — fonte de competência da reversão no DRE (vw_dre_mensal).';
COMMENT ON COLUMN public.sales.cancelled_by IS
  'Usuário que executou o cancelamento (rpc_cancel_sale).';
COMMENT ON COLUMN public.sales.returned_at IS
  'Momento exato da devolução — fonte de competência da reversão no DRE (vw_dre_mensal).';
COMMENT ON COLUMN public.sales.returned_by IS
  'Usuário que executou a devolução (rpc_return_sale).';

-- =============================================================================
-- ROLLBACK
-- =============================================================================
/*
ALTER TABLE public.sales
  DROP COLUMN IF EXISTS cancelled_at,
  DROP COLUMN IF EXISTS cancelled_by,
  DROP COLUMN IF EXISTS returned_at,
  DROP COLUMN IF EXISTS returned_by;
*/
