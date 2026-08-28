export const dynamic = 'force-dynamic'

/**
 * POST /api/fiscal/nfe/emitir-homologacao — Fase Fiscal 2B, seção 12 do
 * pedido.
 *
 * Único input aceito: `sale_id`. NUNCA aceita CNPJ, token, CRT, CFOP ou
 * qualquer dado fiscal arbitrário no corpo — tudo isso vem do
 * ERP/configuração (`company_fiscal_settings`, `company_integrations`,
 * `sale_items`/`products`), nunca do cliente da API. `submitNfeHomologacao`
 * já valida ambiente internamente (aceita 'homologacao'/'producao'
 * conforme `company_fiscal_settings.nfe_environment`) — esta rota não
 * duplica essa lógica, só garante que não há nenhum jeito de o corpo da
 * requisição forçar outro ambiente.
 *
 * Qualquer usuário autenticado da empresa (decisão de produto — operação
 * fiscal de UMA VENDA nunca foi pra ser admin-only; o gate residual da
 * Fase Fiscal 1 foi removido). Configuração fiscal/credenciais
 * continuam admin-only em `/configuracoes/fiscal`, intocadas.
 */

import { z } from 'zod'
import { requireRole } from '@/lib/supabase/session'
import { ok, err, forbidden, validationError } from '@/lib/api/response'
import { submitNfeHomologacao } from '@/services/fiscal/submitNfeHomologacao'

const bodySchema = z.object({
  sale_id: z.number().int().positive(),
})

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

  const result = await submitNfeHomologacao(parsed.data.sale_id, user.company_id)
  if (!result.ok) return err(result.error, result.status)

  // Resultado já é sanitizado por construção — SubmitNfeResult nunca
  // inclui token/payload de request bruto/credencial.
  return ok({ emission: result.data })
}
