export const dynamic = 'force-dynamic'

/**
 * POST /api/fiscal/empresa — sincroniza o cadastro da empresa
 * (company_fiscal_settings) com a Focus NFe (Fase Fiscal 2A, seção 2).
 *
 * Aceita multipart/form-data com um campo opcional `certificado` (arquivo
 * .pfx/.p12) + `senha_certificado`. O arquivo/senha passam por esta rota
 * SÓ EM MEMÓRIA — nunca gravados em disco, nunca persistidos em nenhuma
 * tabela, nunca logados (nem o arquivo, nem o base64, nem a senha).
 * Repassados imediatamente pro serviço, que os encaminha à Focus e
 * descarta.
 *
 * Admin-only — mesma regra de "Fiscal" como módulo bloqueado pra
 * `usuario` já estabelecida na Fase Fiscal 1.
 */

import { requireRole } from '@/lib/supabase/session'
import { ok, err, forbidden, validationError } from '@/lib/api/response'
import { syncFocusEmpresa } from '@/services/fiscal/focusEmpresa.service'

const MAX_CERTIFICATE_BYTES = 10 * 1024 * 1024 // 10MB — folga generosa sobre o tamanho típico de um .pfx

export async function POST(request: Request) {
  const { user, response: unauth } = await requireRole('admin')
  if (unauth) return unauth
  if (!user.company_id) return forbidden()

  let form: FormData
  try {
    form = await request.formData()
  } catch {
    return err('Corpo da requisição deve ser multipart/form-data.', 400)
  }

  const certificadoFile = form.get('certificado')
  const senhaCertificado = form.get('senha_certificado')

  let certificate: { arquivoBase64: string; senha: string } | undefined

  if (certificadoFile instanceof File) {
    if (typeof senhaCertificado !== 'string' || !senhaCertificado) {
      return validationError({ senha_certificado: ['Obrigatória quando um certificado é enviado.'] })
    }
    if (certificadoFile.size > MAX_CERTIFICATE_BYTES) {
      return validationError({ certificado: ['Arquivo excede o tamanho máximo permitido.'] })
    }

    const buffer = Buffer.from(await certificadoFile.arrayBuffer())
    certificate = { arquivoBase64: buffer.toString('base64'), senha: senhaCertificado }
    // `buffer`/`certificate` só vivem no escopo desta função — nunca
    // atribuídos a variável de módulo, nunca logados, descartados pelo GC
    // assim que a resposta é montada.
  } else if (typeof certificadoFile === 'string' && certificadoFile) {
    return validationError({ certificado: ['Envie o certificado como arquivo (multipart), não como texto.'] })
  }

  const result = await syncFocusEmpresa(user.company_id, certificate ? { certificate } : undefined)
  if (!result.ok) return err(result.error, result.status)

  // Nunca inclui certificado/token na resposta — só o resultado do sync.
  return ok({ sync: result.data })
}
