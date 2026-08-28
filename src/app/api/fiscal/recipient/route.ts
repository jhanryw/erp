export const dynamic = 'force-dynamic'

/**
 * GET/POST /api/fiscal/recipient — Fase Fiscal 6, "completar dados
 * fiscais" (seção 19 do pedido).
 *
 * GET  ?sale_id=123 — carrega o destinatário fiscal ATUAL da venda (pode
 *      ser `null`, quando ainda não existe nenhum snapshot), pra
 *      pré-preencher o formulário antes do operador editar — nunca abre
 *      um formulário em branco perdendo o que já foi capturado no
 *      fechamento do PDV.
 * POST { sale_id, recipient } — grava o destinatário fiscal completo
 *      (REPLACE, não PATCH — ver upsertSaleRecipient.ts; por isso o GET
 *      acima existe, pra o formulário sempre partir do estado real).
 *
 * Qualquer usuário autenticado da empresa — mesma regra já usada por
 * `/api/fiscal/{nfe,nfce}/emitir-homologacao` (operação fiscal de venda
 * nunca foi pra ser admin-only). Nunca aceita `company_id` do corpo —
 * sempre o do usuário autenticado (multi-tenancy, seção 32 do pedido).
 */

import { z } from 'zod'
import { requireRole } from '@/lib/supabase/session'
import { ok, err, forbidden, validationError } from '@/lib/api/response'
import { validateCPF } from '@/lib/utils/cpf'
import { validateCNPJ } from '@/lib/utils/cnpj'
import { upsertSaleRecipient, getSaleRecipient, type FiscalRecipientInput } from '@/services/fiscal/upsertSaleRecipient'

const recipientSchema = z.object({
  nome:               z.preprocess((v) => (v === '' || v == null ? null : v), z.string().nullable()),
  cpf:                z.preprocess((v) => (v === '' || v == null ? null : v), z.string().nullable()),
  cnpj:               z.preprocess((v) => (v === '' || v == null ? null : v), z.string().nullable()),
  inscricaoEstadual:  z.preprocess((v) => (v === '' || v == null ? null : v), z.string().nullable()),
  indicadorIe:        z.preprocess((v) => (v === '' || v == null ? null : v), z.union([z.literal(1), z.literal(2), z.literal(9)]).nullable()),
  telefone:           z.preprocess((v) => (v === '' || v == null ? null : v), z.string().nullable()),
  cep:                z.preprocess((v) => (v === '' || v == null ? null : v), z.string().nullable()),
  logradouro:         z.preprocess((v) => (v === '' || v == null ? null : v), z.string().nullable()),
  numero:             z.preprocess((v) => (v === '' || v == null ? null : v), z.string().nullable()),
  complemento:        z.preprocess((v) => (v === '' || v == null ? null : v), z.string().nullable()),
  bairro:             z.preprocess((v) => (v === '' || v == null ? null : v), z.string().nullable()),
  municipio:          z.preprocess((v) => (v === '' || v == null ? null : v), z.string().nullable()),
  municipioIbge:      z.preprocess((v) => (v === '' || v == null ? null : v), z.string().nullable()),
  uf:                 z.preprocess((v) => (v === '' || v == null ? null : v), z.string().nullable()),
  ibgeSource:         z.preprocess((v) => (v === '' || v == null ? null : v), z.enum(['viacep', 'resolve_municipio_ibge', 'manual_confirmado']).nullable()),
})

const bodySchema = z.object({
  sale_id:   z.number().int().positive(),
  recipient: recipientSchema,
})

export async function GET(request: Request) {
  const { user, response: unauth } = await requireRole('usuario')
  if (unauth) return unauth
  if (!user.company_id) return forbidden()

  const { searchParams } = new URL(request.url)
  const saleId = Number(searchParams.get('sale_id'))
  if (!saleId || !Number.isInteger(saleId) || saleId <= 0) return err('sale_id inválido.', 400)

  const result = await getSaleRecipient(saleId, user.company_id)
  if (!result.ok) return err(result.error, result.status)
  return ok({ recipient: result.data })
}

export async function POST(request: Request) {
  const { user, response: unauth } = await requireRole('usuario')
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

  const recipient: FiscalRecipientInput = { ...parsed.data.recipient }

  // Mesma validação de dígito verificador da rota de venda — nunca
  // persiste CPF/CNPJ mal formado só porque passou pelo Zod (Zod só
  // valida forma, não dígito verificador).
  if (recipient.cpf && !validateCPF(recipient.cpf)) {
    return err('CPF do destinatário com dígito verificador inválido.', 422)
  }
  if (recipient.cnpj && !validateCNPJ(recipient.cnpj)) {
    return err('CNPJ do destinatário com dígito verificador inválido.', 422)
  }

  const result = await upsertSaleRecipient(parsed.data.sale_id, user.company_id, recipient)
  if (!result.ok) return err(result.error, result.status)
  return ok({ saved: true })
}
