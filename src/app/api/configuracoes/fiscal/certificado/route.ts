export const dynamic = 'force-dynamic'

/**
 * Motor Fiscal Configurável — Fase 2: certificado digital (A1).
 *
 * GET devolve só METADATA não-secreta (nunca o PFX/senha). POST recebe
 * multipart/form-data (`certificado` + `senha`), valida e persiste — o
 * arquivo/senha passam por esta rota SÓ EM MEMÓRIA, nunca logados, nunca
 * gravados em disco (mesmo padrão já usado em `/api/fiscal/empresa`).
 *
 * Admin-only (seção 40 do pedido — certificado é ação crítica).
 */

import { requireRole } from '@/lib/supabase/session'
import { ok, err, forbidden, validationError } from '@/lib/api/response'
import { auditLog } from '@/lib/audit/log'
import { createAdminClient } from '@/lib/supabase/admin'
import { uploadCertificate, MAX_CERTIFICATE_FILE_SIZE_BYTES } from '@/services/fiscal/certificateService'

const ALLOWED_EXTENSIONS = ['.pfx', '.p12']

export async function GET() {
  const { user, response: unauth } = await requireRole('admin')
  if (unauth) return unauth
  if (!user.company_id) return forbidden()

  const admin = createAdminClient()
  const { data, error } = await (admin as any)
    .from('company_fiscal_settings')
    .select('certificate_status, certificate_subject, certificate_cnpj, certificate_issuer, certificate_serial, certificate_fingerprint, certificate_valid_from, certificate_valid_until, certificate_uploaded_at')
    .eq('company_id', user.company_id)
    .maybeSingle()

  if (error) return err(error.message, 500)
  return ok({ certificate: data ?? null })
}

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

  const file = form.get('certificado')
  const senha = form.get('senha')

  if (!(file instanceof File)) {
    return validationError({ certificado: ['Envie o certificado como arquivo (.pfx/.p12).'] })
  }
  // Nunca confia só na extensão (seção 50 do pedido) — mas rejeita cedo
  // extensões obviamente erradas antes de gastar CPU tentando abrir o PKCS#12.
  const lowerName = file.name.toLowerCase()
  if (!ALLOWED_EXTENSIONS.some((ext) => lowerName.endsWith(ext))) {
    return validationError({ certificado: ['Formato não suportado — envie um arquivo .pfx ou .p12.'] })
  }
  if (file.size > MAX_CERTIFICATE_FILE_SIZE_BYTES) {
    return validationError({ certificado: [`Arquivo excede o tamanho máximo permitido (${MAX_CERTIFICATE_FILE_SIZE_BYTES / 1024}KB).`] })
  }
  if (typeof senha !== 'string' || !senha) {
    return validationError({ senha: ['Senha do certificado é obrigatória.'] })
  }

  const buffer = Buffer.from(await file.arrayBuffer())
  const result = await uploadCertificate({ companyId: user.company_id, userId: user.id, pfxBuffer: buffer, password: senha })
  // `buffer`/`senha` só vivem neste escopo — nunca logados, nunca atribuídos a variável de módulo.

  if (!result.ok) return err(result.error, result.status)

  auditLog({
    userId: user.id, userRole: user.role,
    action: 'update', resource: 'fiscal_certificate',
    detail: `Certificado digital atualizado (fingerprint ${result.data.local.fingerprint}) — sync Focus: ${result.data.focus.status}`,
  })

  // `certificate` preserva o formato anterior (metadata local, usado hoje
  // pela UI) — `focus` é o campo NOVO com o resultado da sincronização.
  // Nunca colapsar os dois: um upload local bem-sucedido com falha de sync
  // não pode aparecer pra UI como "pronto pra emitir".
  return ok({ certificate: result.data.local, focus: result.data.focus })
}
