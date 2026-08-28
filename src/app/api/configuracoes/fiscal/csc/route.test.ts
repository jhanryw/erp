// Regressão do incidente real: um CSC de PRODUÇÃO cadastrado pela UI foi
// sincronizado com a Focus como se fosse homologação, porque a rota nunca
// exigia (nem repassava) o ambiente explicitamente — certificateService.ts
// inferia de um campo de config não relacionado, nunca atualizado. Agora
// `environment` é obrigatório no corpo da requisição, sem default.
import { describe, it, expect, vi, afterEach } from 'vitest'
import { PUT } from './route'
import * as sessionModule from '@/lib/supabase/session'
import * as certificateService from '@/services/fiscal/certificateService'
import * as auditModule from '@/lib/audit/log'

function mockAdminAsAuthorized() {
  vi.spyOn(sessionModule, 'requireRole').mockResolvedValue({
    user: { id: 'user-uuid', role: 'admin', company_id: 1 } as any,
    response: null,
  })
  vi.spyOn(auditModule, 'auditLog').mockImplementation(() => {})
}

function buildRequest(body: unknown): Request {
  return new Request('http://localhost/api/configuracoes/fiscal/csc', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
}

describe('PUT /api/configuracoes/fiscal/csc — environment obrigatório, nunca inferido', () => {
  afterEach(() => { vi.restoreAllMocks() })

  it('sem environment no corpo → 422, nunca chega a chamar saveCsc', async () => {
    mockAdminAsAuthorized()
    const saveCscSpy = vi.spyOn(certificateService, 'saveCsc')

    const res = await PUT(buildRequest({ csc_id: '000001', csc_token: 'token-qualquer' }))
    expect(res.status).toBe(422)
    expect(saveCscSpy).not.toHaveBeenCalled()
  })

  it('environment fora do enum (ex.: "prod") → 422, nunca chega a chamar saveCsc', async () => {
    mockAdminAsAuthorized()
    const saveCscSpy = vi.spyOn(certificateService, 'saveCsc')

    const res = await PUT(buildRequest({ environment: 'prod', csc_id: '000001', csc_token: 'token-qualquer' }))
    expect(res.status).toBe(422)
    expect(saveCscSpy).not.toHaveBeenCalled()
  })

  it('environment=producao explícito → repassado EXATAMENTE assim pra saveCsc, nunca outro valor', async () => {
    mockAdminAsAuthorized()
    const saveCscSpy = vi.spyOn(certificateService, 'saveCsc').mockResolvedValue({
      ok: true, data: { local: { cscId: '000002' }, focus: { status: 'success', lastError: null } },
    })

    const res = await PUT(buildRequest({ environment: 'producao', csc_id: '000002', csc_token: 'token-producao' }))
    expect(res.status).toBe(200)
    expect(saveCscSpy).toHaveBeenCalledWith(expect.objectContaining({ environment: 'producao', cscId: '000002', cscToken: 'token-producao' }))
  })

  it('environment=homologacao explícito → repassado EXATAMENTE assim pra saveCsc', async () => {
    mockAdminAsAuthorized()
    const saveCscSpy = vi.spyOn(certificateService, 'saveCsc').mockResolvedValue({
      ok: true, data: { local: { cscId: '000003' }, focus: { status: 'success', lastError: null } },
    })

    const res = await PUT(buildRequest({ environment: 'homologacao', csc_id: '000003', csc_token: 'token-homolog' }))
    expect(res.status).toBe(200)
    expect(saveCscSpy).toHaveBeenCalledWith(expect.objectContaining({ environment: 'homologacao', cscId: '000003', cscToken: 'token-homolog' }))
  })
})
