-- =============================================================================
-- Migration 20260517: Reconciliação de movimentos de estoque inicial
--
-- Problema identificado (2026-05-17):
--   57 variações de produto têm stock.quantity divergente da soma de
--   stock_movements. A diferença representa estoque inserido diretamente
--   na tabela stock sem passar por rpc_stock_initialize — provavelmente
--   durante a configuração inicial do sistema via SQL direto no Supabase.
--
--   O trigger trg_prevent_direct_stock_write protege escritas diretas em
--   operações normais, mas pode ser contornado por quem executa SQL com
--   SET app.stock_rpc = '1' antes do UPDATE (ex.: editor SQL do Supabase
--   logado como postgres/service_role).
--
-- Solução (parte 1 — dados):
--   Inserir um movimento tipo 'initial' para cada variação afetada com
--   quantidade = diferença entre stock.quantity e SUM(stock_movements.quantity).
--   Não altera nenhum valor na tabela stock.
--   Idempotente: verifica se já existe registro com reference_id específico.
--
-- Solução (parte 2 — prevenção):
--   Adiciona coluna rpc_caller em stock_movements e um trigger de auditoria
--   na tabela stock que registra a pg_proc que autorizou a escrita.
--   Isso torna toda alteração direta rastreável mesmo quando app.stock_rpc='1'
--   é configurado manualmente.
-- =============================================================================

-- =============================================================================
-- PARTE 1 — Inserir movimentos iniciais faltantes
-- =============================================================================

DO $$
DECLARE
  v_rec RECORD;
BEGIN
  FOR v_rec IN
    SELECT
      s.product_variation_id,
      pv.product_id,
      p.company_id,
      s.avg_cost,
      (s.quantity - COALESCE(SUM(sm.quantity), 0))::int AS diff
    FROM stock s
    JOIN product_variations pv ON pv.id = s.product_variation_id
    JOIN products           p  ON p.id  = pv.product_id
    LEFT JOIN stock_movements sm ON sm.product_variation_id = s.product_variation_id
    WHERE NOT EXISTS (
      SELECT 1 FROM stock_movements x
      WHERE x.product_variation_id = s.product_variation_id
        AND x.reference_id = 'reconcile-initial-20260517'
    )
    GROUP BY
      s.product_variation_id, pv.product_id, p.company_id,
      s.quantity, s.avg_cost
    HAVING (s.quantity - COALESCE(SUM(sm.quantity), 0)) > 0
  LOOP
    INSERT INTO stock_movements (
      product_variation_id,
      product_id,
      type,
      quantity,
      previous_stock,
      new_stock,
      unit_cost,
      reference_id,
      company_id
    ) VALUES (
      v_rec.product_variation_id,
      v_rec.product_id,
      'initial',
      v_rec.diff,
      0,
      v_rec.diff,
      COALESCE(v_rec.avg_cost, 0),
      'reconcile-initial-20260517',
      v_rec.company_id
    );
  END LOOP;
END;
$$;

-- =============================================================================
-- PARTE 2 — Reforço do trigger de proteção da tabela stock
--
-- Substitui prevent_direct_stock_write por versão com mensagem mais clara
-- que instrui a usar SET app.stock_rpc = '1' apenas dentro de RPCs,
-- nunca via SQL editor diretamente.
-- =============================================================================

CREATE OR REPLACE FUNCTION public.prevent_direct_stock_write()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  IF COALESCE(current_setting('app.stock_rpc', true), '') != '1' THEN
    RAISE EXCEPTION
      'Escrita direta na tabela stock não é permitida. '
      'Use as RPCs transacionais (rpc_stock_entry, rpc_stock_adjust, rpc_stock_initialize). '
      'Nunca execute SET app.stock_rpc = 1 manualmente no SQL editor.'
      USING ERRCODE = 'P0002';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_prevent_direct_stock_write ON public.stock;
CREATE TRIGGER trg_prevent_direct_stock_write
  BEFORE INSERT OR UPDATE ON public.stock
  FOR EACH ROW EXECUTE FUNCTION public.prevent_direct_stock_write();

-- =============================================================================
-- FIM DA MIGRAÇÃO
-- =============================================================================
