// =============================================================================
// sku-map.ts — Mapa oficial de SKUs Santtorini
//
// Padrão: TTMMCCTTAA (10 dígitos numéricos)
//   TT = tipo de produto   (2 dígitos)
//   MM = modelo            (2 dígitos)
//   CC = cor               (2 dígitos, '00' = sem cor)
//   TT = tamanho           (2 dígitos, '00' = único tamanho)
//   AA = ano de coleção    (2 dígitos, ex: '26' para 2026)
//
// REGRAS:
//   1. generateSKU() lança Error para qualquer valor não mapeado — sem fallback.
//   2. SKU pai (produto) usa '0000' para CC+TT → TTMM0000AA.
//   3. SKU de variação usa os códigos reais de cor e tamanho.
//   4. Todo tipo em SKU_TIPO DEVE ter uma entrada em SKU_MODELO.
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

}

// ─── Cores ───────────────────────────────────────────────────────────────────
// Cada cor deve ter um código único de 2 dígitos.
// Proibido: dois nomes de cor com o mesmo código (causa colisão de SKU).

export const SKU_COR: Record<string, string> = {
  preto:           '01',
  branco:          '02',
  nude:            '03',
  vermelho:        '04',
  rosa:            '05',
  vinho:           '06',
  azul:            '07',
  verde:           '08',
  amarelo:         '09',
  roxo:            '10',
  bege:            '11',
  marrom:          '12',
  lilas:           '13',
  bege_com_preto:  '14',
  cinza:           '15',
  laranja:         '16',
  dourado:         '17',
  prateado:        '18',
  azul_marinho:    '19',
  rosa_bebe:       '20',
  pink:            '21',
  coral:           '22',
  off_white:       '23',
  caramelo:        '24',
  verde_oliva:     '25',
  azul_celeste:    '26',
  terracota:       '27',
  bordo:           '28',
  champagne:       '29',
  creme:           '30',
  salmao:          '31',
  lavanda:         '32',
  menta:           '33',
  cinza_mescla:    '34',
  nude_escuro:     '35',
  azul_royal:      '36',
  verde_esmeralda: '37',
  preto_com_rosa:  '38',
  branco_com_preto:'39',
  cinza_com_preto: '40',
  rosa_com_preto:  '41',
  rose:            '42',
  chumbo:          '43',
}

// ─── Tamanhos ─────────────────────────────────────────────────────────────────

export const SKU_TAMANHO: Record<string, string> = {
  pp:   '05',
  p:    '01',
  p_m:  '07',
  m:    '02',
  g:    '03',
  g_gg: '08',
  gg:   '04',
  xgg:  '06',
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

// ─── Interface pública ────────────────────────────────────────────────────────

export interface GenerateSKUParams {
  tipo:     string
  modelo:   string
  cor?:     string    // undefined → '00' (sem cor definida / produto pai)
  tamanho?: string    // undefined → '00' (tamanho único / produto pai)
  ano?:     string    // undefined → ano corrente; deve estar em SKU_ANO
}

// ─── Geração de SKU ───────────────────────────────────────────────────────────

/**
 * Gera o SKU de 10 dígitos seguindo o padrão Santtorini: TTMMCCTTAA.
 *
 * Lança Error explícito para qualquer valor não mapeado.
 * Nunca produz um SKU silenciosamente incorreto.
 *
 * @example
 * generateSKU({ tipo: 'calcinha', modelo: 'sem_costura', cor: 'bege', tamanho: 'm', ano: '2026' })
 * // → '0204110226'
 */
export function generateSKU(params: GenerateSKUParams): string {
  if (!params.tipo)   throw new Error('Tipo é obrigatório para gerar SKU')
  if (!params.modelo) throw new Error('Modelo é obrigatório para gerar SKU')

  // TT — tipo de produto
  const normTipo = normalizeKey(params.tipo)
  const TT = SKU_TIPO[normTipo as keyof typeof SKU_TIPO]
  if (!TT) {
    throw new Error(`Tipo de produto '${params.tipo}' não encontrado no mapa oficial. Tipos válidos: ${Object.keys(SKU_TIPO).join(', ')}`)
  }

  // MM — modelo
  const modelMap = SKU_MODELO[TT]
  if (!modelMap) {
    throw new Error(`Tipo '${params.tipo}' não possui modelos definidos no mapa oficial`)
  }
  const normModelo = normalizeKey(params.modelo)
  const MM = modelMap[normModelo]
  if (!MM) {
    throw new Error(`Modelo '${params.modelo}' não encontrado para o tipo '${params.tipo}'. Modelos válidos: ${Object.keys(modelMap).join(', ')}`)
  }

  // CC — cor ('00' quando omitida = produto pai)
  const normCor = params.cor ? normalizeKey(params.cor) : ''
  const CC = params.cor === undefined ? '00' : SKU_COR[normCor]
  if (params.cor !== undefined && !CC) {
    throw new Error(`Cor '${params.cor}' não encontrada no mapa oficial. Cores válidas: ${Object.keys(SKU_COR).join(', ')}`)
  }

  // TT (tamanho) — ('00' quando omitido = produto pai)
  const normTamanho = params.tamanho ? normalizeKey(params.tamanho) : ''
  const TS = params.tamanho === undefined ? '00' : SKU_TAMANHO[normTamanho]
  if (params.tamanho !== undefined && !TS) {
    throw new Error(`Tamanho '${params.tamanho}' não encontrado no mapa oficial. Tamanhos válidos: ${Object.keys(SKU_TAMANHO).join(', ')}`)
  }

  // AA — ano de coleção (fallback: ano corrente; lança se não mapeado)
  const normAno = params.ano ? String(params.ano).trim() : new Date().getFullYear().toString()
  const AA = SKU_ANO[normAno]
  if (!AA) {
    const anosValidos = Object.keys(SKU_ANO).filter(k => k.length === 4).join(', ')
    throw new Error(`Ano '${normAno}' não suportado no mapa oficial. Anos válidos: ${anosValidos}`)
  }

  // Composição final: TTMMCCTSAA
  const sku = `${TT}${MM}${CC}${TS}${AA}`

  if (sku.length !== 10) {
    // Salvaguarda de desenvolvimento — nunca deve ocorrer com mapas corretos
    throw new Error(`Falha interna na geração do SKU: comprimento incorreto (${sku.length}). Gerado: '${sku}'`)
  }

  return sku
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
  return generateSKU({ tipo, modelo, cor: undefined, tamanho: undefined, ano })
}
