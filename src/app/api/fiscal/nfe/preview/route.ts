export const dynamic = 'force-dynamic'

/**
 * POST /api/fiscal/nfe/preview — Fase Fiscal 2A, seção 12 do pedido.
 *
 * Carrega uma venda, monta o payload Focus (best-effort, mesmo com dado
 * ausente — os campos ficam ausentes no payload, nunca inventados) e
 * valida separadamente. NUNCA transmite (`POST /v2/nfe` não é chamado em
 * lugar nenhum deste projeto ainda). Admin-only.
 *
 * Corpo aceito: `{ saleId: number, naturezaOperacao?: string,
 * presencaComprador?: number, modalidadeFrete?: number }` — os overrides
 * de operação existem porque `presença do comprador`/`natureza da
 * operação` não têm fonte própria no schema hoje (ver
 * loadSaleFiscalContext.ts) — sem override, assume o cenário padrão desta
 * fase (venda não presencial pela Internet).
 *
 * Resposta nunca inclui token/segredo — `buildNfePayload` e
 * `loadSaleFiscalContext` não têm acesso a credencial nenhuma (só
 * `focusIntegration.available`/`reason`, nunca o token em si).
 */

import { z } from 'zod'
import { requireRole } from '@/lib/supabase/session'
import { ok, err, forbidden, validationError } from '@/lib/api/response'
import { loadSaleFiscalContext, FiscalContextError } from '@/services/fiscal/loadSaleFiscalContext'
import { validateNfeReadiness } from '@/services/fiscal/validateFiscalReadiness'
import { buildNfePayload, FiscalBuildError } from '@/services/fiscal/buildNfePayload'
import { buildFiscalDocumentSnapshot } from '@/services/fiscal/buildFiscalSnapshot'
import { FiscalRuleNotImplementedError } from '@/lib/fiscal/taxRules'
import { randomUUID } from 'node:crypto'

const bodySchema = z.object({
  saleId: z.number().int().positive(),
  naturezaOperacao: z.string().min(1).max(60).optional(),
  presencaComprador: z.union([z.literal(0), z.literal(1), z.literal(2), z.literal(3), z.literal(4), z.literal(5), z.literal(9)]).optional(),
  modalidadeFrete: z.union([z.literal(0), z.literal(1), z.literal(2), z.literal(9)]).optional(),
})

export async function POST(request: Request) {
  const { user, response: unauth } = await requireRole('admin')
  if (unauth) return unauth
  if (!user.company_id) return forbidden()

  let body: unknown
  try {
    body = await request.json()
  } catch {
    return err('JSON inválido.', 400)
  }

  const parsed = bodySchema.safeParse(body)
  if (!parsed.success) return validationError(parsed.error.flatten())

  const providerRef = `preview-${user.company_id}-${parsed.data.saleId}-${randomUUID()}`

  let context
  try {
    context = await loadSaleFiscalContext({
      saleId: parsed.data.saleId,
      companyId: user.company_id,
      providerRef,
      environment: 'homologacao',
      operationOverrides: {
        naturezaOperacao: parsed.data.naturezaOperacao,
        presencaComprador: parsed.data.presencaComprador,
        modalidadeFrete: parsed.data.modalidadeFrete,
      },
    })
  } catch (loadErr) {
    if (loadErr instanceof FiscalContextError) return err(loadErr.message, 404)
    throw loadErr
  }

  const validationErrors = validateNfeReadiness(context)

  let payload: unknown = null
  let payloadError: string | null = null
  try {
    payload = buildNfePayload(context)
  } catch (buildErr) {
    // FiscalRuleNotImplementedError (CRT 2/3, método de pagamento sem
    // regra) capturado explicitamente — mesma correção de
    // submitNfeHomologacao.ts (Problema Alto #4 da auditoria da Fase 3).
    payloadError = buildErr instanceof FiscalRuleNotImplementedError || buildErr instanceof FiscalBuildError
      ? buildErr.message
      : 'Falha inesperada ao montar o payload.'
  }

  let snapshot: unknown = null
  try {
    snapshot = buildFiscalDocumentSnapshot(context)
  } catch {
    snapshot = null // mesmos campos ausentes já reportados em validationErrors/payloadError — não duplica erro
  }

  return ok({
    saleId: parsed.data.saleId,
    environment: context.environment,
    readyToTransmit: validationErrors.length === 0 && payloadError === null,
    validationErrors,
    payload,
    payloadError,
    snapshot,
    transmitted: false,
  })
}
