export const SKU_TIPO = {
  camiseta: 'CA',
  calca: 'CL',
  vestido: 'VD',
  saia: 'SA',
  short: 'SH',
  casaco: 'CS',
  jaqueta: 'JQ',
  moletom: 'MO',
  biquini: 'BQ',
  maio: 'MA',
  acessorio: 'AC',
  bolsa: 'BO',
  sapato: 'SP',
  outro: 'OU'
} as const

export const SKU_MODELO: Record<string, Record<string, string>> = {
  CA: { basica: 'BS', polo: 'PL', regata: 'RG', estampada: 'ES', manga_longa: 'ML' },
  CL: { jeans: 'JN', moletom: 'MO', alfaiataria: 'AL', legging: 'LG', pantalona: 'PT' },
  VD: { curto: 'CU', midi: 'MD', longo: 'LO', festa: 'FE' },
  SA: { curta: 'CU', midi: 'MD', longa: 'LO', plisada: 'PL' },
  SH: { jeans: 'JN', moletom: 'MO', alfaiataria: 'AL', tactel: 'TC' },
  CS: { tricot: 'TR', la: 'LA', sobretudo: 'SO' },
  JQ: { jeans: 'JN', couro: 'PU', corta_vento: 'CV' },
  MO: { canguru: 'CG', careca: 'CR', ziper: 'ZP' },
  BQ: { cortininha: 'CT', tomara_caia: 'TC', asa_delta: 'AD' },
  MA: { tradicional: 'TR', engano: 'EN', cavado: 'CV' },
  AC: { cinto: 'CI', colar: 'CL', brinco: 'BR', pulseira: 'PU', oculos: 'OC', chapeu: 'CH' },
  BO: { transversal: 'TR', mao: 'MA', mochila: 'MC', praia: 'PR' },
  SP: { tenis: 'TE', sandalia: 'SA', bota: 'BO', rasteira: 'RS', salto: 'SL' },
  OU: { padrao: 'PD', generico: 'GN' }
}

export const SKU_COR: Record<string, string> = {
  preto: 'PR',
  branco: 'BR',
  azul: 'AZ',
  vermelho: 'VM',
  verde: 'VD',
  amarelo: 'AM',
  rosa: 'RS',
  cinza: 'CZ',
  marrom: 'MR',
  bege: 'BG',
  laranja: 'LR',
  roxo: 'RX',
  dourado: 'DO',
  prata: 'PT',
  nude: 'ND',
  estampado: 'ES',
  multicor: 'MC'
}

export const SKU_TAMANHO: Record<string, string> = {
  pp: 'PP',
  p: '0P',
  m: '0M',
  g: '0G',
  gg: 'GG',
  xg: 'XG',
  x1: 'X1',
  x2: 'X2',
  x3: 'X3',
  '34': '34',
  '36': '36',
  '38': '38',
  '40': '40',
  '42': '42',
  '44': '44',
  '46': '46',
  '48': '48',
  unico: 'UN'
}

function getSafeCode(value: string | undefined | null, map: Record<string, string>, defaultCode = '00'): string {
  if (!value) return defaultCode
  const normalized = value.toLowerCase().trim().normalize("NFD").replace(/[\u0300-\u036f]/g, "")
  if (map[normalized]) return map[normalized]
  
  // Fallback: pega 2 primeiras consoantes, ou 2 primeiras letras uppercase
  const consonants = normalized.replace(/[aeiou\s]/g, '').toUpperCase()
  if (consonants.length >= 2) return consonants.substring(0, 2)
  return normalized.substring(0, 2).toUpperCase().padEnd(2, '0')
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

  const TT = getSafeCode(params.tipo, SKU_TIPO, 'OU')
  const modelMap = SKU_MODELO[TT] || SKU_MODELO['OU']
  const MM = getSafeCode(params.modelo, modelMap, 'PD')
  const CC = getSafeCode(params.cor, SKU_COR, '00')
  const TTM = getSafeCode(params.tamanho, SKU_TAMANHO, '00')
  
  let AA = '00'
  if (params.ano) {
    const anoStr = String(params.ano).trim()
    AA = anoStr.length === 4 ? anoStr.substring(2, 4) : anoStr.substring(0, 2).padEnd(2, '0')
  } else {
    AA = new Date().getFullYear().toString().substring(2, 4)
  }

  // TTMMCCTTAA (10 caracteres)
  const sku = `${TT}${MM}${CC}${TTM}${AA}`
  
  if (sku.length !== 10) {
    throw new Error(`Falha na geração (tamanho incorreto): gerado ${sku} com ${sku.length} chars.`)
  }

  return sku
}

export function generateParentSKU(tipo: string, modelo: string, ano?: string): string {
  return generateSKU({ tipo, modelo, cor: '00', tamanho: '00', ano })
}
