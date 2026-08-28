import { describe, it, expect, vi, afterEach } from 'vitest'
import { makeSyncEntry, readFocusManagementSync, recordFocusManagementSync } from './focusManagementSync'
import * as companyIntegrations from '@/services/integrations/company-integrations.service'

describe('makeSyncEntry', () => {
  it('monta uma entrada com timestamp ISO e lastError null por padrão', () => {
    const entry = makeSyncEntry('success')
    expect(entry.status).toBe('success')
    expect(entry.lastError).toBeNull()
    expect(() => new Date(entry.lastSyncAt).toISOString()).not.toThrow()
  })

  it('aceita lastError explícito pra status=error', () => {
    const entry = makeSyncEntry('error', 'falha de rede')
    expect(entry.status).toBe('error')
    expect(entry.lastError).toBe('falha de rede')
  })
})

describe('readFocusManagementSync', () => {
  it('settings null/undefined → {} , nunca lança', () => {
    expect(readFocusManagementSync(null)).toEqual({})
    expect(readFocusManagementSync(undefined)).toEqual({})
  })

  it('settings sem focusManagementSync → {}', () => {
    expect(readFocusManagementSync({ environment: 'homologacao' })).toEqual({})
  })

  it('settings.focusManagementSync malformado (não-objeto) → {} , nunca propaga lixo', () => {
    expect(readFocusManagementSync({ focusManagementSync: 'string-invalida' })).toEqual({})
  })

  it('devolve o estado salvo quando presente', () => {
    const state = { company: { status: 'success', lastSyncAt: '2026-01-01T00:00:00.000Z', lastError: null } }
    expect(readFocusManagementSync({ focusManagementSync: state })).toEqual(state)
  })
})

describe('recordFocusManagementSync', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('grava um recurso sem apagar os outros já existentes (merge)', async () => {
    const updateSpy = vi.spyOn(companyIntegrations, 'updateCompanyIntegration').mockResolvedValue({ ok: true, data: {} as any })
    const existingSettings = {
      focusManagementSync: {
        company: { status: 'success', lastSyncAt: '2026-01-01T00:00:00.000Z', lastError: null },
      },
    }

    const result = await recordFocusManagementSync(1, { id: 10, settings: existingSettings }, { certificate: makeSyncEntry('success') })

    expect(result.ok).toBe(true)
    expect(updateSpy).toHaveBeenCalledOnce()
    const patch = updateSpy.mock.calls[0][2]
    const syncState = (patch.settings as any).focusManagementSync
    expect(syncState.company.status).toBe('success')
    expect(syncState.certificate.status).toBe('success')
  })

  it('CSC é mesclado por ambiente — gravar homologação nunca apaga produção já sincronizada', async () => {
    const updateSpy = vi.spyOn(companyIntegrations, 'updateCompanyIntegration').mockResolvedValue({ ok: true, data: {} as any })
    const existingSettings = {
      focusManagementSync: {
        csc: { producao: { status: 'success', lastSyncAt: '2026-01-01T00:00:00.000Z', lastError: null } },
      },
    }

    await recordFocusManagementSync(1, { id: 10, settings: existingSettings }, { csc: { environment: 'homologacao', entry: makeSyncEntry('success') } })

    const patch = updateSpy.mock.calls[0][2]
    const syncState = (patch.settings as any).focusManagementSync
    expect(syncState.csc.homologacao.status).toBe('success')
    expect(syncState.csc.producao.status).toBe('success')
  })

  it('propaga falha de updateCompanyIntegration sem lançar', async () => {
    vi.spyOn(companyIntegrations, 'updateCompanyIntegration').mockResolvedValue({ ok: false, error: 'db indisponível', status: 500 })

    const result = await recordFocusManagementSync(1, { id: 10, settings: {} }, { company: makeSyncEntry('error', 'x') })
    expect(result.ok).toBe(false)
  })
})
