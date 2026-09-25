-- =============================================================================
-- 202609271000_channel_listings_reconcile.sql — Marketplace Hub: reconciliação
-- periódica canal → Qarvon (somente leitura no canal)
--
--   1. channel_listings.last_reconciled_at   — última TENTATIVA de reconciliação
--      periódica (é carimbada no claim; ordena o próximo lote).
--   2. channel_listings.last_reconcile_error — NULL = última reconciliação ok;
--      texto = erro individual daquele anúncio (não interrompe os outros).
--   3. rpc_claim_channel_listings_reconcile — reserva um lote dos anúncios
--      vivos (active/paused com id externo) mais antigos, com
--      FOR UPDATE SKIP LOCKED: duas execuções sobrepostas do job nunca pegam
--      o mesmo anúncio. Não escreve nada no canal.
--
-- Roda DEPOIS de 202609261100. 100% aditiva, idempotente, sem backfill:
-- vínculos existentes ficam com last_reconciled_at NULL (entram primeiro).
-- =============================================================================

BEGIN;

ALTER TABLE public.channel_listings ADD COLUMN IF NOT EXISTS last_reconciled_at TIMESTAMPTZ;
ALTER TABLE public.channel_listings ADD COLUMN IF NOT EXISTS last_reconcile_error TEXT;

CREATE INDEX IF NOT EXISTS idx_channel_listings_reconcile_due
  ON public.channel_listings (last_reconciled_at NULLS FIRST, id)
  WHERE local_status IN ('active', 'paused') AND external_listing_id IS NOT NULL;

CREATE OR REPLACE FUNCTION public.rpc_claim_channel_listings_reconcile(
  p_limit             int,
  p_min_age_seconds   int
)
RETURNS SETOF public.channel_listings
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  RETURN QUERY
  WITH due AS (
    SELECT cl.id
    FROM channel_listings cl
    WHERE cl.local_status IN ('active', 'paused')
      AND cl.external_listing_id IS NOT NULL
      AND (cl.last_reconciled_at IS NULL
           OR cl.last_reconciled_at < NOW() - make_interval(secs => GREATEST(p_min_age_seconds, 60)))
    ORDER BY cl.last_reconciled_at NULLS FIRST, cl.id
    LIMIT LEAST(GREATEST(p_limit, 1), 500)
    FOR UPDATE SKIP LOCKED
  )
  UPDATE channel_listings cl
  SET last_reconciled_at = NOW()
  FROM due
  WHERE cl.id = due.id
  RETURNING cl.*;
END;
$$;

REVOKE ALL ON FUNCTION public.rpc_claim_channel_listings_reconcile(int, int) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.rpc_claim_channel_listings_reconcile(int, int) TO service_role;

COMMENT ON COLUMN public.channel_listings.last_reconciled_at IS
  'Última tentativa de reconciliação periódica canal → Qarvon (somente leitura no canal). Sucesso quando last_reconcile_error IS NULL.';
COMMENT ON COLUMN public.channel_listings.last_reconcile_error IS
  'Erro individual da última reconciliação periódica deste anúncio; NULL = ok.';

COMMIT;

NOTIFY pgrst, 'reload schema';
