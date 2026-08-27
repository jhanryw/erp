-- =============================================================================
-- 202609051200_fiscal_operation_policies_consolidate_4_types.sql
--
-- Motor Fiscal Configurável — consolidação de 7 para 4 `operation_type`.
--
-- HISTÓRICO: este arquivo documenta uma migration que já foi executada
-- MANUALMENTE no Supabase self-hosted de produção e já foi VALIDADA contra
-- o banco real (as 4 policies da Santtorini conferidas linha a linha, CHECK
-- constraint conferido, ausência das 5 policies antigas confirmada). Não é
-- uma migration pendente de execução — existe só pra o histórico do Git
-- refletir o estado real do banco. NÃO EXECUTAR NOVAMENTE.
--
-- ─── Achado real desta sessão (ordem corrigida) ─────────────────────────
-- A primeira versão deste arquivo registrava os UPDATEs de renomeação
-- ANTES do DROP CONSTRAINT do CHECK antigo. Isso falha em qualquer
-- instalação NOVA (onde a migration 202609051100 ainda está com o CHECK
-- restrito aos 7 valores antigos): o primeiro `UPDATE ... SET
-- operation_type = 'retail_pickup'` violaria esse CHECK antes de ele ser
-- removido. Só não falhou nesta instalação porque o dono aplicou
-- manualmente a ordem correta (DROP CONSTRAINT primeiro), diferente do
-- que este arquivo registrava. Corrigido abaixo para refletir a ordem
-- REAL executada — DROP CONSTRAINT sempre vem antes de qualquer UPDATE/
-- DELETE que rename para um valor fora do CHECK antigo.
--
-- ─── O que mudou ────────────────────────────────────────────────────────
-- Antes: 7 `operation_type` (pos_retail/pos_pickup/pos_delivery/wholesale/
-- website/whatsapp/manual) — o modelo antigo MISTURAVA canal/origem da
-- venda (pos/whatsapp/manual/website) com natureza fiscal da operação
-- (wholesale), sem distinção clara entre os dois conceitos.
-- Depois: 4 `operation_type`, um por NATUREZA FISCAL DA OPERAÇÃO
-- (retail_pickup/retail_delivery/wholesale/website). WhatsApp/manual/PDV
-- continuam existindo como `sales_channel`/`sale_origin` da venda — só
-- deixaram de ter uma política fiscal PRÓPRIA. Ver
-- `src/lib/fiscal/resolveOperationType.ts` pra nova precedência completa
-- (website checado ANTES de wholesale — decisão explícita: venda do site
-- de atacado agora segue a política 'website', não mais 'wholesale').
--
-- Nenhum valor de comportamento (fiscal_enabled/document_mode/auto_issue/
-- auto_print/print_non_fiscal_receipt) foi alterado pra Santtorini — os
-- valores das policies renomeadas já batiam exatamente com o desejado,
-- confirmado por diagnóstico antes de aplicar.
-- =============================================================================

BEGIN;

-- 1. Remove o CHECK antigo PRIMEIRO — sem isso, os renames abaixo (passo 3)
-- violariam a constraint (ela só aceitava os 7 valores antigos).
ALTER TABLE public.fiscal_operation_policies
  DROP CONSTRAINT fiscal_operation_policies_operation_type_check;

-- 2. Onde pos_retail E pos_pickup existiam para a mesma empresa, descarta
-- pos_pickup (pos_retail venceu — únicas linhas reais desta instalação,
-- Santtorini, tinham valores idênticos entre os dois).
DELETE FROM public.fiscal_operation_policies a
USING public.fiscal_operation_policies b
WHERE a.operation_type = 'pos_pickup'
  AND b.operation_type = 'pos_retail'
  AND a.company_id = b.company_id;

-- 3. Renomeia o que sobrou de pos_retail/pos_pickup para retail_pickup.
UPDATE public.fiscal_operation_policies
SET operation_type = 'retail_pickup'
WHERE operation_type IN ('pos_retail', 'pos_pickup');

-- 4. Renomeia pos_delivery para retail_delivery.
UPDATE public.fiscal_operation_policies
SET operation_type = 'retail_delivery'
WHERE operation_type = 'pos_delivery';

-- 5. Remove whatsapp/manual — canal deixa de ter política fiscal própria.
DELETE FROM public.fiscal_operation_policies
WHERE operation_type IN ('whatsapp', 'manual');

-- 6. Só agora, com todas as linhas já usando os 4 valores novos, recria o
-- CHECK restrito a eles.
ALTER TABLE public.fiscal_operation_policies
  ADD CONSTRAINT fiscal_operation_policies_operation_type_check
  CHECK (
    operation_type IN (
      'retail_pickup',
      'retail_delivery',
      'wholesale',
      'website'
    )
  );

COMMIT;
