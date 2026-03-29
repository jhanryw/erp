export const SKU_TIPO = {
  sutia: '01',
  calcinha: '02',
  body: '03',
  pijama: '04',
  camisola: '05',
  baby_doll: '06',
  robe: '07',
  top: '08',
  short_doll: '09',
  pijama_vestido: '10',
  pijama_americano: '11',
  pijama_com_calcinha: '12',
  pijama_rendado: '13',
  conjunto_calcinha_sutia: '14'
} as const

export const SKU_MODELO: Record<string, Record<string, string>> = {
  '01': { // Modelos de sutiã
    basico_com_bojo: '01',
    basico_sem_bojo: '02',
    renda: '03',
    top: '04',
    com_aro: '05',
    sem_aro: '06'
  },
  '02': { // Modelos de calcinha
    algodao: '01',
    poliamida: '02',
    renda: '03',
    sem_costura: '04',
    cintura_alta: '05',
    fio_dental: '06'
  },
  '04': { // Modelos de pijama
    americano: '01',
    renda: '02',
    vestido: '03',
    short_doll: '04'
  },
  '14': { // Modelos de conjunto (tipo 14)
    basico_com_bojo: '01',
    basico_sem_bojo: '02',
    renda_sem_bojo: '03',
    renda_com_bojo: '04',
    bustie_cropped_renda: '05',
    conjunto_com_calcinha_fio_dental: '06'
  }
}

export const SKU_COR: Record<string, string> = {
  preto: '01',
  branco: '02',
  nude: '03',
  vermelho: '04',
  rosa: '05',
  vinho: '06',
  azul: '07',
  verde: '08',
  amarelo: '09',
  roxo: '10',
  lilas: '10',
  bege: '11',
  marrom: '12'
}

export const SKU_TAMANHO: Record<string, string> = {
  p: '01',
  m: '02',
  g: '03',
  gg: '04'
}

export const SKU_ANO: Record<string, string> = {
  '2024': '24',
  '24': '24',
  '2025': '25',
  '25': '25',
  '2026': '26',
  '26': '26'
}

function normalizeKey(value: string | undefined | null): string {
  if (!value) return ''
  return value.toLowerCase().trim().normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/[^a-z0-9]/g, '_').replace(/_+/g, '_').replace(/^_|_$/g, '')
}

export interface GenerateSKUParams {
  tipo: string
  modelo: string
  cor?: string
  tamanho?: string
  ano?: string
}

export function generateSKU(params: GenerateSKUParams): string {
  if (!params.tipo) throw new Error('Tipo é obrigatório para gerar SKU')
  if (!params.modelo) throw new Error('Modelo é obrigatório para gerar SKU')

  const normTipo = normalizeKey(params.tipo)
  const TT = SKU_TIPO[normTipo as keyof typeof SKU_TIPO]
  if (!TT) {
    throw new Error(`Tipo de produto '${params.tipo}' não encontrado no mapa oficial`)
  }

  // Modelos
  const modelMap = SKU_MODELO[TT] || { padrao: '01' } // Fallback estrutural: se o tipo (ex: body) não tem mapa específico de modelos, usamos '01'
  const normModelo = normalizeKey(params.modelo)
  const MM = modelMap[normModelo]
  if (!MM && !modelMap['padrao']) {
    throw new Error(`Modelo '${params.modelo}' não encontrado para o tipo '${params.tipo}' no mapa oficial`)
  }

  // Cores
  const normCor = params.cor ? normalizeKey(params.cor) : ''
  const CC = params.cor === undefined ? '00' : SKU_COR[normCor]
  if (params.cor !== undefined && !CC) {
    throw new Error(`Cor '${params.cor}' não encontrada no mapa oficial`)
  }

  // Tamanhos
  const normTamanho = params.tamanho ? normalizeKey(params.tamanho) : ''
  const TTM = params.tamanho === undefined ? '00' : SKU_TAMANHO[normTamanho]
  if (params.tamanho !== undefined && !TTM) {
    throw new Error(`Tamanho '${params.tamanho}' não encontrado no mapa oficial`)
  }
  
  // Ano
  const normAno = params.ano ? String(params.ano).trim() : new Date().getFullYear().toString()
  const AA = SKU_ANO[normAno]
  if (params.ano !== undefined && !AA) {
    throw new Error(`Ano '${params.ano}' não suportado no mapa oficial`)
  }

  // TTMMCCTTAA (10 caracteres, estritamente numérico)
  const sku = `${TT}${MM || '01'}${CC}${TTM}${AA}`
  
  if (sku.length !== 10) {
    throw new Error(`Falha na geração: formato de tamanho incorreto. Gerado: ${sku}`)
  }

  return sku
}

export function generateParentSKU(tipo: string, modelo: string, ano?: string): string {
  // O SKU pai é formado contendo '00' para os identificadores de variante (Cor e Tamanho)
  // Exemplo parent: TTMM0000AA
  return generateSKU({ tipo, modelo, cor: undefined, tamanho: undefined, ano })
}
