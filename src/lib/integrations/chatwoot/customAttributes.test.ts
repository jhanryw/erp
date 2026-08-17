import { describe, it, expect, vi, afterEach } from 'vitest'
import { ensureChatwootCustomAttributes, buildQarvonSizeAttributeDefinitions, QARVON_CUSTOM_ATTRIBUTES, QARVON_SIZE_PRODUCT_TYPES } from './customAttributes'
import * as client from './client'

const config = { baseUrl: 'https://chat.example.com', accountId: '1', apiToken: 'token' }

const TOTAL_ATTRIBUTES = QARVON_CUSTOM_ATTRIBUTES.length + QARVON_SIZE_PRODUCT_TYPES.length

describe('buildQarvonSizeAttributeDefinitions', () => {
  it('gera 1 definição por Tipo real de QARVON_SIZE_PRODUCT_TYPES, chave qarvon_size_<slug>', () => {
    const defs = buildQarvonSizeAttributeDefinitions()
    expect(defs).toHaveLength(QARVON_SIZE_PRODUCT_TYPES.length)
    expect(defs.map((d) => d.key)).toContain('qarvon_size_sutia')
    expect(defs.map((d) => d.key)).toContain('qarvon_size_calcinha')
    expect(defs.every((d) => d.type === 0)).toBe(true)
  })

  it('nunca inclui sex_shop nem os 4 Tipos sem categoria confirmada (gap conhecido)', () => {
    const defs = buildQarvonSizeAttributeDefinitions()
    const keys = defs.map((d) => d.key)
    expect(keys).not.toContain('qarvon_size_sex_shop')
    expect(keys).not.toContain('qarvon_size_pijama_vestido')
    expect(keys).not.toContain('qarvon_size_pijama_americano')
    expect(keys).not.toContain('qarvon_size_camisola_americana')
    expect(keys).not.toContain('qarvon_size_pijama_rendado')
  })
})

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
      expect(result.data.created).toHaveLength(TOTAL_ATTRIBUTES - 1)
      expect(result.data.created).not.toContain('qarvon_customer_id')
    }
    expect(createSpy).toHaveBeenCalledTimes(TOTAL_ATTRIBUTES - 1)
  })

  it('quando nenhum atributo existe ainda, cria todos (fixos + qarvon_size_* por Tipo)', async () => {
    vi.spyOn(client, 'listChatwootCustomAttributeDefinitions').mockResolvedValue({ ok: true, data: [] })
    const createSpy = vi.spyOn(client, 'createChatwootCustomAttributeDefinition').mockResolvedValue({ ok: true, data: {} as any })

    const result = await ensureChatwootCustomAttributes(config)

    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.data.created).toHaveLength(TOTAL_ATTRIBUTES)
      expect(result.data.created).toContain('qarvon_categories')
      expect(result.data.created).toContain('qarvon_size_sutia')
    }
    expect(createSpy).toHaveBeenCalledTimes(TOTAL_ATTRIBUTES)
  })

  it('quando todos já existem, não chama create nenhuma vez (idempotência real)', async () => {
    const allAttrs = [...QARVON_CUSTOM_ATTRIBUTES, ...buildQarvonSizeAttributeDefinitions()]
    const existing = allAttrs.map((a, i) => ({ id: i, attribute_key: a.key, attribute_display_name: a.displayName, attribute_display_type: 'text', attribute_model: 'contact_attribute' }))
    vi.spyOn(client, 'listChatwootCustomAttributeDefinitions').mockResolvedValue({ ok: true, data: existing as any })
    const createSpy = vi.spyOn(client, 'createChatwootCustomAttributeDefinition').mockResolvedValue({ ok: true, data: {} as any })

    const result = await ensureChatwootCustomAttributes(config)

    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.data.created).toHaveLength(0)
      expect(result.data.alreadyExisted).toHaveLength(TOTAL_ATTRIBUTES)
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
