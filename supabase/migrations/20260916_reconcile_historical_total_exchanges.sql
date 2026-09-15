-- =============================================================================
-- 20260916_reconcile_historical_total_exchanges.sql
--
-- Reconciliação histórica — depende de
-- 20260915_fix_rpc_process_exchange_no_returned_status.sql já aplicada
-- (corrige o comportamento FUTURO; esta migration só conserta o PASSADO).
--
-- ESCOPO: exatamente as 7 vendas identificadas e provadas individualmente
-- na auditoria (2026-09-15), cada uma com evidência própria de troca total
-- indevidamente marcada como devolução:
--   114, 156, 264, 281, 519, 692, 821
--
-- Esta migration NÃO varre a base procurando "qualquer venda parecida" —
-- só toca essas 7 linhas, e mesmo assim só se TODOS os invariantes abaixo
-- se confirmarem de novo, no momento em que ela rodar (defesa contra o
-- estado ter mudado entre a auditoria e a execução):
--
--   1. sales.id está na lista das 7 E company_id = 1 (Santtorini — a
--      única empresa onde essas vendas foram auditadas).
--   2. sales.status = 'returned' agora (se já não for, não há nada pra
--      reconciliar nessa linha — idempotência).
--   3. Existe pelo menos 1 exchange com status='completed' e
--      original_sale_id = essa venda.
--   4. SUM(exchange_items.quantity_returned) das trocas completed dessa
--      venda >= SUM(sale_items.quantity) da venda — confirma de novo que
--      foi troca TOTAL (mesma condição que a RPC antiga usava pra marcar
--      returned), não parcial.
--   5. NÃO existe nenhum audit_logs com action='return' pra essa venda —
--      confirma de novo que não houve devolução financeira real
--      concorrente (o audit_log de rpc_return_sale é sempre 'return',
--      nunca 'exchange' — os dois nunca se confundem).
--
-- QUAL STATUS RESTAURAR — prova estrutural, não suposição:
--   rpc_create_sale (toda versão vigente, incl. a atual em
--   202608311201_rpc_create_sale_wholesale_channel.sql) grava
--   `INSERT INTO sales (..., status, ...) VALUES (..., 'paid', ...)` —
--   'paid' é LITERAL, hardcoded, nunca outro valor no momento da criação.
--   Auditoria exaustiva de todo o repositório (migrations + código TS)
--   não encontrou NENHUM outro ponto que grave sales.status='pending',
--   'shipped' ou 'delivered' em qualquer momento — os ÚNICOS UPDATEs de
--   sales.status em toda a base são para 'cancelled' (rpc_cancel_sale) e
--   'returned' (rpc_return_sale e, até esta correção, rpc_process_exchange
--   na troca total). Como nenhuma das 7 vendas foi cancelada nem tem
--   devolução financeira real concorrente (invariante 5 acima), e como
--   'paid' é o ÚNICO valor que o sistema jamais escreve nessa coluna fora
--   desses três caminhos, 'paid' é o único estado anterior estruturalmente
--   possível para as 7 — não uma suposição, uma eliminação exaustiva.
--
--   Caso alguma das 7 não satisfaça algum invariante quando esta migration
--   rodar, ela é PULADA (não alterada) e reportada via RAISE NOTICE — não
--   há UPDATE cego em lote.
--
-- returned_at/returned_by são zerados junto (NULL) nas linhas
-- reconciliadas — essas colunas, por definição
-- (20260721_sales_reversal_audit_columns.sql: "Momento exato da devolução
-- — fonte de competência da reversão no DRE"), significam devolução
-- financeira real. Preencher com o momento de uma troca deixaria uma
-- venda 'paid' com metadado de devolução, incoerente com o novo modelo.
--
-- IDEMPOTENTE: rodar duas vezes é seguro — na segunda vez, o invariante 2
-- (status='returned') já não vale mais pras linhas já reconciliadas, então
-- elas são report adas como "já reconciliada" e ignoradas.
--
-- Efeito colateral esperado no faturamento histórico já reportado
-- (dashboards/DRE de meses passados): as 7 vendas voltam a contar como
-- receita nos meses em que ocorreram — R$561,90 no total, já quantificado
-- e confirmado linha a linha na auditoria. Isso É o objetivo desta
-- migration, não um efeito colateral indesejado.
-- =============================================================================

DO $$
DECLARE
  v_target_ids     int[] := ARRAY[114, 156, 264, 281, 519, 692, 821];
  v_id             int;
  v_sale           record;
  v_total_orig_qty numeric;
  v_total_exch_qty numeric;
  v_has_direct_return boolean;
  v_reconciled_count int := 0;
  v_skipped_count    int := 0;
BEGIN
  FOREACH v_id IN ARRAY v_target_ids LOOP

    SELECT id, sale_number, status, company_id, total, returned_at
    INTO v_sale
    FROM public.sales
    WHERE id = v_id
    FOR UPDATE;

    IF NOT FOUND THEN
      RAISE NOTICE 'PULADA venda id=% — não encontrada.', v_id;
      v_skipped_count := v_skipped_count + 1;
      CONTINUE;
    END IF;

    IF v_sale.company_id <> 1 THEN
      RAISE NOTICE 'PULADA venda % (id=%) — company_id=% inesperado (esperado 1).',
        v_sale.sale_number, v_id, v_sale.company_id;
      v_skipped_count := v_skipped_count + 1;
      CONTINUE;
    END IF;

    IF v_sale.status <> 'returned' THEN
      RAISE NOTICE 'PULADA venda % (id=%) — status atual é "%", não "returned" (já reconciliada antes, ou mudou por outro motivo — nada a fazer).',
        v_sale.sale_number, v_id, v_sale.status;
      v_skipped_count := v_skipped_count + 1;
      CONTINUE;
    END IF;

    IF NOT EXISTS (
      SELECT 1 FROM public.exchanges
      WHERE original_sale_id = v_id AND status = 'completed'
    ) THEN
      RAISE NOTICE 'PULADA venda % (id=%) — nenhuma exchange completed encontrada para original_sale_id=%.',
        v_sale.sale_number, v_id, v_id;
      v_skipped_count := v_skipped_count + 1;
      CONTINUE;
    END IF;

    SELECT COALESCE(SUM(quantity), 0) INTO v_total_orig_qty
    FROM public.sale_items WHERE sale_id = v_id;

    SELECT COALESCE(SUM(ei.quantity_returned), 0) INTO v_total_exch_qty
    FROM public.exchange_items ei
    JOIN public.exchanges ex ON ex.id = ei.exchange_id
    WHERE ex.original_sale_id = v_id AND ex.status = 'completed';

    IF v_total_exch_qty < v_total_orig_qty THEN
      RAISE NOTICE 'PULADA venda % (id=%) — quantidade trocada (%) não cobre 100%% da quantidade original (%) — não é troca total, não deveria ter virado returned por esse motivo (investigar separadamente, não reconciliar aqui).',
        v_sale.sale_number, v_id, v_total_exch_qty, v_total_orig_qty;
      v_skipped_count := v_skipped_count + 1;
      CONTINUE;
    END IF;

    SELECT EXISTS (
      SELECT 1 FROM public.audit_logs
      WHERE resource = 'sale' AND resource_id = v_id::text AND action = 'return'
    ) INTO v_has_direct_return;

    IF v_has_direct_return THEN
      RAISE NOTICE 'PULADA venda % (id=%) — existe audit_log action=return: pode ter havido devolução financeira real concorrente, reconciliação manual necessária.',
        v_sale.sale_number, v_id;
      v_skipped_count := v_skipped_count + 1;
      CONTINUE;
    END IF;

    UPDATE public.sales
    SET status      = 'paid',
        returned_at = NULL,
        returned_by = NULL,
        updated_at  = NOW()
    WHERE id = v_id;

    RAISE NOTICE 'RECONCILIADA venda % (id=%) — status restaurado para "paid" (total=%, era returned indevidamente por troca total).',
      v_sale.sale_number, v_id, v_sale.total;
    v_reconciled_count := v_reconciled_count + 1;

  END LOOP;

  RAISE NOTICE '=== Reconciliação concluída: % venda(s) restaurada(s), % pulada(s) de % candidata(s) ===',
    v_reconciled_count, v_skipped_count, array_length(v_target_ids, 1);
END $$;

-- =============================================================================
-- PÓS-VALIDAÇÃO — rode depois de aplicar, confirme visualmente
-- =============================================================================
-- SELECT id, sale_number, status, total, returned_at, returned_by
-- FROM public.sales
-- WHERE id IN (114, 156, 264, 281, 519, 692, 821)
-- ORDER BY id;

-- =============================================================================
-- ROLLBACK
-- =============================================================================
-- Snapshot obrigatório ANTES de aplicar esta migration (rode e guarde o
-- resultado):
--   SELECT id, status, returned_at, returned_by FROM public.sales
--   WHERE id IN (114, 156, 264, 281, 519, 692, 821);
--
-- Para reverter, restaure linha a linha os valores exatos capturados no
-- snapshot (não existe um valor único de "status anterior ao rollback" —
-- é sempre o que o snapshot registrou):
--   UPDATE public.sales SET status = <snapshot>, returned_at = <snapshot>,
--     returned_by = <snapshot> WHERE id = <id>;
