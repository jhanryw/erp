import { describe, it, expect, vi, afterEach } from 'vitest'
import { ensureChatwootCustomAttributes, QARVON_CUSTOM_ATTRIBUTES } from './customAttributes'
import * as client from './client'

const config = { baseUrl: 'https://chat.example.com', accountId: '1', apiToken: 'token' }

describe('ensureChatwootCustomAttributes — idempotente (seção 12/40 do pedido)', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('cria só os atributos ausentes, nunca recria os que já existem', async () => {
    const existing = [{ id: 1, attribute_key: 'qarvon_customer_id', attribute_display_name: '', attribute_display_type: 'text', attribute_model: 'contact_attribute' }]
    vi.spyOn(client, 'listChatwootCustomAttributeDefinitions').mockResolvedValue({ ok: true, data: existing as any })
    const createSpy = vi.spyOn(client, 'createChatwootCustomAttributeDefinition').mockResolvedValue({ ok: true, data: {} as any })

    const result = await ensureChatwootCustomAttributes(config)

    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.data.alreadyExisted).toEqual(['qarvon_customer_id'])
      expect(result.data.created).toHaveLength(QARVON_CUSTOM_ATTRIBUTES.length - 1)
      expect(result.data.created).not.toContain('qarvon_customer_id')
    }
    expect(createSpy).toHaveBeenCalledTimes(QARVON_CUSTOM_ATTRIBUTES.length - 1)
  })

  it('quando nenhum atributo existe ainda, cria todos', async () => {
    vi.spyOn(client, 'listChatwootCustomAttributeDefinitions').mockResolvedValue({ ok: true, data: [] })
    const createSpy = vi.spyOn(client, 'createChatwootCustomAttributeDefinition').mockResolvedValue({ ok: true, data: {} as any })

    const result = await ensureChatwootCustomAttributes(config)

    expect(result.ok).toBe(true)
    if (result.ok) expect(result.data.created).toHaveLength(QARVON_CUSTOM_ATTRIBUTES.length)
    expect(createSpy).toHaveBeenCalledTimes(QARVON_CUSTOM_ATTRIBUTES.length)
  })

  it('quando todos já existem, não chama create nenhuma vez (idempotência real)', async () => {
    const existing = QARVON_CUSTOM_ATTRIBUTES.map((a, i) => ({ id: i, attribute_key: a.key, attribute_display_name: a.displayName, attribute_display_type: 'text', attribute_model: 'contact_attribute' }))
    vi.spyOn(client, 'listChatwootCustomAttributeDefinitions').mockResolvedValue({ ok: true, data: existing as any })
    const createSpy = vi.spyOn(client, 'createChatwootCustomAttributeDefinition').mockResolvedValue({ ok: true, data: {} as any })

    const result = await ensureChatwootCustomAttributes(config)

    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.data.created).toHaveLength(0)
      expect(result.data.alreadyExisted).toHaveLength(QARVON_CUSTOM_ATTRIBUTES.length)
    }
    expect(createSpy).not.toHaveBeenCalled()
  })

  it('propaga falha da listagem sem tentar criar nada', async () => {
    vi.spyOn(client, 'listChatwootCustomAttributeDefinitions').mockResolvedValue({ ok: false, error: { kind: 'http', status: 401, message: 'unauthorized' } })
    const createSpy = vi.spyOn(client, 'createChatwootCustomAttributeDefinition').mockResolvedValue({ ok: true, data: {} as any })

    const result = await ensureChatwootCustomAttributes(config)

    expect(result.ok).toBe(false)
    expect(createSpy).not.toHaveBeenCalled()
  })
})
