// =============================================================================
// sku-map.ts — Mapa oficial de tipo/modelo de produto (Santtorini)
//
// Padrão: TTMMCCTTAA (10 dígitos numéricos)
//   TT = tipo de produto   (2 dígitos) — resolvido aqui, via SKU_TIPO
//   MM = modelo            (2 dígitos) — resolvido aqui, via SKU_MODELO
//   CC = cor               (2 dígitos, '00' = sem cor) — resolvido
//                            externamente (variation_values.sku_code)
//   TT = tamanho           (2 dígitos, '00' = único tamanho) — idem
//   AA = ano de coleção    (2 dígitos, ex: '26' para 2026)
//
// Este arquivo é responsável apenas por tipo/modelo (estáticos, sem tabela
// dinâmica equivalente) e pela composição final do SKU a partir de códigos
// de cor/tamanho já resolvidos externamente (ver generateSKUFromCodes).
// Cor e tamanho não têm mais mapa estático aqui — são 100% dinâmicos,
// resolvidos via variation_values.sku_code (src/lib/sku/sku-dynamic.ts).
//
// REGRAS:
//   1. generateSKUFromCodes() lança Error para tipo/modelo não mapeado —
//      sem fallback.
//   2. SKU pai (produto) usa '00' para CC e TT → TTMM0000AA.
//   3. Todo tipo em SKU_TIPO DEVE ter uma entrada em SKU_MODELO.
// =============================================================================

// ─── Tipos de produto ─────────────────────────────────────────────────────────

export const SKU_TIPO = {
  sutia:                  '01',
  calcinha:               '02',
  body:                   '03',
  pijama:                 '04',
  camisola:               '05',
  baby_doll:              '06',
  robe:                   '07',
  top:                    '08',
  short_doll:             '09',
  pijama_vestido:         '10',
  pijama_americano:       '11',
  camisola_americana:     '12',
  pijama_rendado:         '13',
  conjunto_calcinha_sutia:'14',
  cinta:                  '15',
} as const

// ─── Modelos por tipo ─────────────────────────────────────────────────────────
// Cada tipo listado em SKU_TIPO DEVE ter uma entrada aqui.
// Regra: se o tipo não tem modelos definidos, ele não pode ser usado.

export const SKU_MODELO: Record<string, Record<string, string>> = {

  '01': { // Sutiã
    basico_com_bojo: '01',
    basico_sem_bojo: '02',
    renda:           '03',
    top:             '04',
    com_aro:         '05',
    sem_aro:         '06',
  },

  '02': { // Calcinha
    algodao:      '01',
    poliamida:    '02',
    renda:        '03',
    sem_costura:  '04',
    cintura_alta: '05',
    fio_dental:   '06',
  },

  '03': { // Body
    regata:      '01',
    manga_longa: '02',
    renda:       '03',
    decote_v:    '04',
  },

  '04': { // Pijama (conjunto curto/longo genérico)
    americano:  '01',
    renda:      '02',
    vestido:    '03',
    short_doll: '04',
  },

  '05': { // Camisola
    curta:     '01',
    longa:     '02',
    renda:     '03',
    sem_manga: '04',
  },

  '06': { // Baby Doll
    classico:     '01',
    renda:        '02',
    com_calcinha: '03',
  },

  '07': { // Robe
    curto: '01',
    longo: '02',
    renda: '03',
    pluma: '04',
  },

  '08': { // Top
    cropped:  '01',
    regata:   '02',
    com_bojo: '03',
    sem_bojo: '04',
    renda:    '05',
  },

  '09': { // Short Doll
    basico: '01',
    renda:  '02',
  },

  '10': { // Pijama Vestido
    curto: '01',
    longo: '02',
    renda: '03',
  },

  '11': { // Pijama Americano
    manga_longa:  '01',
    manga_curta:  '02',
    regata:       '03',
  },

  '12': { // Camisola Americana
    padrao:  '01',
    renda:   '02',
    sexy:    '03',
  },

  '13': { // Pijama Rendado
    com_bojo: '01',
    sem_bojo: '02',
  },

  '14': { // Conjunto Calcinha + Sutiã
    basico_com_bojo:                  '01',
    basico_sem_bojo:                  '02',
    renda_sem_bojo:                   '03',
    renda_com_bojo:                   '04',
    bustie_cropped_renda:             '05',
    conjunto_com_calcinha_fio_dental: '06',
  },

  '15': { // Cinta
    liga:              '01',
    modeladora:        '02',
    body_modelador:    '03',
    regata_modeladora: '04',
  },

}

// ─── Anos de coleção ──────────────────────────────────────────────────────────
// Aceita tanto o ano completo ('2026') quanto o sufixo curto ('26').
// Expandido até 2035 para evitar quebra automática em virada de ano.

export const SKU_ANO: Record<string, string> = {
  '2024': '24', '24': '24',
  '2025': '25', '25': '25',
  '2026': '26', '26': '26',
  '2027': '27', '27': '27',
  '2028': '28', '28': '28',
  '2029': '29', '29': '29',
  '2030': '30', '30': '30',
  '2031': '31', '31': '31',
  '2032': '32', '32': '32',
  '2033': '33', '33': '33',
  '2034': '34', '34': '34',
  '2035': '35', '35': '35',
}

// ─── Normalização de chaves ───────────────────────────────────────────────────

export function normalizeKey(value: string | undefined | null): string {
  if (!value) return ''
  return value
    .toLowerCase()
    .trim()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_|_$/g, '')
}

// ─── SKU pai (produto base) ───────────────────────────────────────────────────

/**
 * Gera o SKU pai do produto: TTMM0000AA.
 * Não inclui cor nem tamanho (ambos '00').
 *
 * @example
 * generateParentSKU('conjunto_calcinha_sutia', 'renda_sem_bojo', '2026')
 * // → '1403000026'
 */
export function generateParentSKU(tipo: string, modelo: string, ano: string): string {
  return generateSKUFromCodes({ tipo, modelo, corCode: undefined, tamanhoCode: undefined, ano })
}

// ─── Geração de SKU a partir de códigos diretos ───────────────────────────────

export interface GenerateSKUFromCodesParams {
  tipo:          string
  modelo:        string
  /** Código de 2 dígitos da cor (ex: '38'). undefined → '00' (produto pai). */
  corCode?:      string
  /** Código de 2 dígitos do tamanho (ex: '02'). undefined → '00' (produto pai). */
  tamanhoCode?:  string
  ano?:          string
}

/**
 * Gera o SKU de 10 dígitos usando os códigos de cor e tamanho diretamente,
 * sem consultar o mapa hardcoded. Usado com getOrCreateColorSkuCode /
 * getOrCreateSizeSkuCode para suportar cores e tamanhos novos dinamicamente.
 *
 * @example
 * generateSKUFromCodes({ tipo: 'calcinha', modelo: 'sem_costura', corCode: '47', tamanhoCode: '02', ano: '2026' })
 * // → '0204470226'
 */
export function generateSKUFromCodes(params: GenerateSKUFromCodesParams): string {
  if (!params.tipo)   throw new Error('Tipo é obrigatório para gerar SKU')
  if (!params.modelo) throw new Error('Modelo é obrigatório para gerar SKU')

  const normTipo = normalizeKey(params.tipo)
  const TT = SKU_TIPO[normTipo as keyof typeof SKU_TIPO]
  if (!TT) {
    throw new Error(`Tipo de produto '${params.tipo}' não encontrado no mapa oficial. Tipos válidos: ${Object.keys(SKU_TIPO).join(', ')}`)
  }

  const modelMap = SKU_MODELO[TT]
  if (!modelMap) {
    throw new Error(`Tipo '${params.tipo}' não possui modelos definidos no mapa oficial`)
  }
  const normModelo = normalizeKey(params.modelo)
  const MM = modelMap[normModelo]
  if (!MM) {
    throw new Error(`Modelo '${params.modelo}' não encontrado para o tipo '${params.tipo}'. Modelos válidos: ${Object.keys(modelMap).join(', ')}`)
  }

  const CC = params.corCode     ?? '00'
  const TS = params.tamanhoCode ?? '00'

  const normAno = params.ano ? String(params.ano).trim() : new Date().getFullYear().toString()
  const AA = SKU_ANO[normAno]
  if (!AA) {
    const anosValidos = Object.keys(SKU_ANO).filter(k => k.length === 4).join(', ')
    throw new Error(`Ano '${normAno}' não suportado no mapa oficial. Anos válidos: ${anosValidos}`)
  }

  const sku = `${TT}${MM}${CC}${TS}${AA}`
  if (sku.length !== 10) {
    throw new Error(`Falha interna na geração do SKU: comprimento incorreto (${sku.length}). Gerado: '${sku}'`)
  }

  return sku
}
