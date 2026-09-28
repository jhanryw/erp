import { describe, it, expect } from 'vitest'
import type { ChannelListingDraft } from '@/lib/channels/types'
import { buildAddItemBody, buildTaxInfo, mapItemStatus, resolveEffectivePhysical, snapshotFromItem, validateAgainstRequirements, validateDraftLocally, type ShopeeRequirementsSnapshot } from './listingPayload'

function draft(shopee: Record<string, unknown> = {}, over: Partial<ChannelListingDraft> = {}): ChannelListingDraft {
  return {
    sellerSku: 'SUT-PRETO-M', productName: 'Sutiã Renda', title: 'Sutiã Renda', description: 'Sutiã de renda confortável.',
    categoryId: '102', price: 49.9, currencyId: 'BRL', quantity: 7, pictureUrls: ['https://x/p.jpg'], attributes: [],
    channelOptions: { listing_type_id: null, condition: 'new', shopee: { condition: 'NEW', weight_kg: 0.2, attributes: [{ attribute_id: 1001, values: [{ value_id: 12 }] }], brand: { no_brand: true }, ...shopee } },
    ...over,
  }
}

const req: ShopeeRequirementsSnapshot = {
  category: { category_id: 102, parent_category_id: 101, name: 'Sutiãs', original_name: 'Bras', has_children: false, is_leaf: true, path: [] },
  attributes: [
    { attribute_id: 1001, name: 'Material', mandatory: true, input_type: 'single_select', input_type_code: 1, validation: 'none', quantitative: false, units: [], max_value_count: 1, values: [{ value_id: 11, name: 'Algodão', value_unit: null }, { value_id: 12, name: 'Renda', value_unit: null }], support_search_value: false, accepts_custom_value: false, multiple: false },
    { attribute_id: 1002, name: 'Estilo', mandatory: false, input_type: 'free_text', input_type_code: 3, validation: 'string', quantitative: false, units: [], max_value_count: null, values: [], support_search_value: false, accepts_custom_value: true, multiple: false },
  ],
  brand: { is_mandatory: true, input_type: 'DROP_DOWN', brands: [{ brand_id: 0, original_brand_name: 'No Brand', display_brand_name: 'No Brand' }, { brand_id: 5001, original_brand_name: 'Santtorini', display_brand_name: 'Santtorini' }], no_brand_option: { brand_id: 0, original_brand_name: 'No Brand', display_brand_name: 'No Brand' }, truncated: false },
  logistics: [{ logistics_channel_id: 90001, name: 'SPX', enabled: true, fee_type: 'SIZE_INPUT', min_weight: 0.01, max_weight: 30, max_dimension: null }],
}

const codes = (xs: Array<{ code: string }>) => xs.map((x) => x.code)

describe('validação local', () => {
  it('draft completo passa', () => {
    expect(validateDraftLocally(draft())).toEqual([])
  })

  it('peso ausente BLOQUEIA com missing_weight (nunca valor padrão)', () => {
    expect(codes(validateDraftLocally(draft({ weight_kg: null })))).toEqual(['missing_weight'])
    expect(codes(validateDraftLocally(draft({ weight_kg: -1 })))).toEqual(['invalid_weight'])
  })

  it('dimensões: tudo ou nada; inteiros positivos', () => {
    expect(codes(validateDraftLocally(draft({ dimension: { package_height: 10 } })))).toEqual(['incomplete_dimensions'])
    expect(codes(validateDraftLocally(draft({ dimension: { package_height: 10, package_length: 5.5, package_width: 3 } })))).toEqual(['invalid_dimensions'])
    expect(validateDraftLocally(draft({ dimension: { package_height: 10, package_length: 20, package_width: 3 } }))).toEqual([])
  })

  it('condition obrigatória e só NEW/USED (o "new" genérico do core NÃO vale como condição Shopee)', () => {
    expect(codes(validateDraftLocally(draft({ condition: null })))).toEqual(['missing_condition'])
    expect(codes(validateDraftLocally(draft({ condition: 'SEMINOVO' })))).toEqual(['invalid_condition'])
  })

  it('nome, descrição, preço, estoque, SKU, imagens e categoria', () => {
    const d = draft({}, { title: ' ', description: null, price: 0, quantity: -1, sellerSku: '', pictureUrls: [], categoryId: 'MLB1' })
    expect(codes(validateDraftLocally(d))).toEqual(['missing_name', 'missing_description', 'invalid_price', 'missing_stock', 'missing_sku', 'missing_images', 'invalid_category'])
  })
})

describe('validação contra requisitos da categoria', () => {
  it('ok: resolve "No Brand" pela entrada da API e o primeiro canal habilitado', () => {
    const r = validateAgainstRequirements(draft(), req)
    expect(r.errors).toEqual([])
    expect(r.resolved).toEqual({ attributeList: [{ attribute_id: 1001, values: [{ value_id: 12 }] }], brand: { brand_id: 0, original_brand_name: 'No Brand' }, logisticChannelId: 90001 })
  })

  it('atributo obrigatório ausente, valor fora da lista e texto livre em seleção', () => {
    expect(codes(validateAgainstRequirements(draft({ attributes: [] }), req).errors)).toEqual(['missing_attribute'])
    expect(codes(validateAgainstRequirements(draft({ attributes: [{ attribute_id: 1001, values: [{ value_id: 99 }] }] }), req).errors)).toEqual(['invalid_attribute_value'])
    expect(codes(validateAgainstRequirements(draft({ attributes: [{ attribute_id: 1001, values: [{ value_id: 0, original_value_name: 'Seda' }] }] }), req).errors)).toEqual(['invalid_attribute_value'])
    expect(validateAgainstRequirements(draft({ attributes: [{ attribute_id: 1001, values: [{ value_id: 11 }] }, { attribute_id: 1002, values: [{ value_id: 0, original_value_name: 'Básico' }] }] }), req).errors).toEqual([])
  })

  it('marca obrigatória ausente → missing_brand; "sem marca" não oferecido → no_brand_not_offered; marca fora da lista → invalid_brand', () => {
    expect(codes(validateAgainstRequirements(draft({ brand: null }), req).errors)).toEqual(['missing_brand'])
    const noNoBrand = { ...req, brand: { ...req.brand, no_brand_option: null, brands: [req.brand.brands[1]] } }
    expect(codes(validateAgainstRequirements(draft(), noNoBrand).errors)).toEqual(['no_brand_not_offered'])
    expect(codes(validateAgainstRequirements(draft({ brand: { brand_id: 777, original_brand_name: 'X' } }), req).errors)).toEqual(['invalid_brand'])
    expect(validateAgainstRequirements(draft({ brand: { brand_id: 5001, original_brand_name: 'Santtorini' } }), req).resolved.brand).toEqual({ brand_id: 5001, original_brand_name: 'Santtorini' })
  })

  it('marca não exigida e ausente → sem brand no payload', () => {
    const optional = { ...req, brand: { ...req.brand, is_mandatory: false } }
    const r = validateAgainstRequirements(draft({ brand: null }), optional)
    expect(r.errors).toEqual([])
    expect(r.resolved.brand).toBeNull()
  })

  it('categoria não-folha, logística indisponível, canal inválido e peso fora do limite do canal', () => {
    expect(codes(validateAgainstRequirements(draft(), { ...req, category: { ...req.category, is_leaf: false, has_children: true } }).errors)).toEqual(['category_not_leaf'])
    expect(codes(validateAgainstRequirements(draft(), { ...req, logistics: [] }).errors)).toEqual(['logistics_unavailable'])
    expect(codes(validateAgainstRequirements(draft({ logistic_channel_id: 1 }), req).errors)).toEqual(['invalid_logistic_channel'])
    expect(codes(validateAgainstRequirements(draft({ weight_kg: 50 }), req).errors)).toEqual(['weight_out_of_channel_limits'])
  })
})

describe('payload add_item', () => {
  it('campos principais', () => {
    const d = draft({ dimension: { package_height: 5, package_length: 20, package_width: 15 } })
    const r = validateAgainstRequirements(d, req)
    expect(buildAddItemBody(d, { imageIds: ['img-1', 'img-2'], choices: r.resolved })).toEqual({
      original_price: 49.9,
      description: 'Sutiã de renda confortável.',
      weight: 0.2,
      item_name: 'Sutiã Renda',
      item_status: 'NORMAL',
      logistic_info: [{ logistic_id: 90001, enabled: true }],
      category_id: 102,
      image: { image_id_list: ['img-1', 'img-2'] },
      item_sku: 'SUT-PRETO-M',
      condition: 'NEW',
      seller_stock: [{ stock: 7 }],
      dimension: { package_height: 5, package_length: 20, package_width: 15 },
      attribute_list: [{ attribute_id: 1001, attribute_value_list: [{ value_id: 12 }] }],
      brand: { brand_id: 0, original_brand_name: 'No Brand' },
    })
  })

  it('sem dimensões → campo omitido; valor livre leva original_value_name', () => {
    const d = draft({ attributes: [{ attribute_id: 1001, values: [{ value_id: 11 }] }, { attribute_id: 1002, values: [{ value_id: 0, original_value_name: 'Básico' }] }] })
    const body = buildAddItemBody(d, { imageIds: ['i'], choices: validateAgainstRequirements(d, req).resolved })
    expect(body).not.toHaveProperty('dimension')
    expect(body.attribute_list).toContainEqual({ attribute_id: 1002, attribute_value_list: [{ value_id: 0, original_value_name: 'Básico' }] })
  })

  it('snapshot: item_id → external_listing_id e external_product_id; sem variant/group; status mapeado', () => {
    const s = snapshotFromItem({ item_id: 123, item_status: 'NORMAL', item_sku: 'A', category_id: 102, price_info: [{ original_price: 10 }] }, '555')
    expect(s).toMatchObject({ externalListingId: '123', externalProductId: '123', externalVariantId: null, externalGroupId: null, externalIds: { item_id: '123', shop_id: '555' }, externalStatus: 'active', price: 10, sellerSku: 'A', sellerId: '555' })
    expect(mapItemStatus('SELLER_DELETE')).toBe('closed')
    expect(mapItemStatus('UNLIST')).toBe('paused')
  })
})

describe('dados físicos do PIM (draft.shippingDimensions)', () => {
  const pim = (over: Record<string, unknown> = {}) => ({ weightKg: 0.35, lengthCm: 25, widthCm: 18, heightCm: 4, dimensionsPartial: false, invalid: [], ...over })

  it('PIM é a fonte primária: peso e dimensões do produto vão ao payload (manual ignorado)', () => {
    const d = draft({ weight_kg: 9, dimension: { package_height: 1, package_length: 1, package_width: 1 } }, { shippingDimensions: pim() })
    expect(resolveEffectivePhysical(d)).toMatchObject({ weightKg: 0.35, weightSource: 'pim', dimensionSource: 'pim', errors: [] })
    const body = buildAddItemBody(d, { imageIds: ['i'], choices: validateAgainstRequirements(d, req).resolved })
    expect(body.weight).toBe(0.35)
    expect(body.dimension).toEqual({ package_height: 4, package_length: 25, package_width: 18 })
  })

  it('PIM sem peso → override manual como fallback; nenhum dos dois → missing_weight', () => {
    expect(resolveEffectivePhysical(draft({ weight_kg: 0.2 }, { shippingDimensions: pim({ weightKg: null }) }))).toMatchObject({ weightKg: 0.2, weightSource: 'manual' })
    expect(codes(validateDraftLocally(draft({ weight_kg: null }, { shippingDimensions: pim({ weightKg: null, lengthCm: null, widthCm: null, heightCm: null }) })))).toEqual(['missing_weight'])
  })

  it('peso zero/negativo cadastrado no PIM → invalid_weight (sem cair no manual)', () => {
    expect(codes(validateDraftLocally(draft({ weight_kg: 0.2 }, { shippingDimensions: pim({ weightKg: null, invalid: ['weightKg@product'] }) })))).toEqual(['invalid_weight'])
  })

  it('dimensão parcial no PIM (só largura) → incomplete_dimensions, sem misturar com manual', () => {
    const d = draft({ dimension: { package_height: 1, package_length: 1, package_width: 1 } }, { shippingDimensions: pim({ lengthCm: null, heightCm: null, dimensionsPartial: true }) })
    expect(codes(validateDraftLocally(d))).toEqual(['incomplete_dimensions'])
  })

  it('PIM sem dimensões → manual completo é usado; nada → dimensão omitida', () => {
    const none = pim({ lengthCm: null, widthCm: null, heightCm: null })
    expect(resolveEffectivePhysical(draft({ dimension: { package_height: 2, package_length: 3, package_width: 4 } }, { shippingDimensions: none })).dimensionSource).toBe('manual')
    const d = draft({}, { shippingDimensions: none })
    expect(buildAddItemBody(d, { imageIds: ['i'], choices: validateAgainstRequirements(d, req).resolved })).not.toHaveProperty('dimension')
  })

  it('limite de peso do canal usa o peso do PIM', () => {
    expect(codes(validateAgainstRequirements(draft({ weight_kg: 0.2 }, { shippingDimensions: pim({ weightKg: 50 }) }), req).errors)).toEqual(['weight_out_of_channel_limits'])
  })
})

describe('tax_info (fiscal do produto)', () => {
  const fiscal = (over: Record<string, unknown> = {}) => ({ ncm: '6212.10.00', cest: '28.038.00', origin: 0, measureUnit: 'UN', ...over })

  it('NCM/CEST/origem/unidade válidos → tax_info normalizado; nunca CFOP/CSOSN', () => {
    const d = draft({}, { fiscalInfo: fiscal() })
    const body = buildAddItemBody(d, { imageIds: ['i'], choices: validateAgainstRequirements(d, req).resolved })
    expect(body.tax_info).toEqual({ ncm: '62121000', cest: '2803800', origin: '0', measure_unit: 'UN' })
    expect(JSON.stringify(body)).not.toMatch(/cfop|csosn/)
  })

  it('sem dados fiscais → tax_info omitido, sem erro (opcional na doc)', () => {
    const d = draft({}, { fiscalInfo: null })
    expect(validateDraftLocally(d)).toEqual([])
    expect(buildAddItemBody(d, { imageIds: ['i'], choices: validateAgainstRequirements(d, req).resolved })).not.toHaveProperty('tax_info')
    expect(buildTaxInfo({ fiscalInfo: fiscal({ ncm: null, cest: null, origin: null, measureUnit: null }) })).toEqual({ taxInfo: null, errors: [], warnings: [] })
  })

  it('NCM/CEST/origem mal formados bloqueiam', () => {
    expect(codes(validateDraftLocally(draft({}, { fiscalInfo: fiscal({ ncm: '1234' }) })))).toEqual(['invalid_ncm'])
    expect(codes(validateDraftLocally(draft({}, { fiscalInfo: fiscal({ cest: '12' }) })))).toEqual(['invalid_cest'])
    expect(codes(validateDraftLocally(draft({}, { fiscalInfo: fiscal({ origin: 9 }) })))).toEqual(['invalid_origin'])
  })

  it('unidade: alias PAR→PARES; fora da lista → aviso e omitida', () => {
    expect(buildTaxInfo({ fiscalInfo: fiscal({ measureUnit: 'PAR' }) }).taxInfo?.measure_unit).toBe('PARES')
    const r = buildTaxInfo({ fiscalInfo: fiscal({ measureUnit: 'XYZ' }) })
    expect(r.taxInfo).not.toHaveProperty('measure_unit')
    expect(codes(r.warnings)).toEqual(['measure_unit_not_supported'])
  })
})
