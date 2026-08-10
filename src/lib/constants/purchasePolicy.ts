/**
 * Política de cobertura de estoque por Curva ABC — Compras Inteligentes.
 *
 * Centraliza os números que hoje são fixos (90/30/30 dias, mínimo de
 * reposição da Curva C, limiares de urgência) para que nenhum "magic
 * number" fique espalhado pelo service/UI. Pensado para, no futuro, virar
 * configuração editável (ex.: tabela `parameters`, já usada para
 * `purchase_target_stock_days` em vw_purchase_suggestions) sem precisar
 * mexer em mais de um lugar — hoje é só um módulo de constantes.
 *
 * Não decide NADA sobre a Curva ABC em si (isso continua sendo
 * mv_abc_by_revenue, intocada) — só o que fazer com cada classe.
 */

export type PolicyCurve = 'A' | 'B' | 'C' | 'NEW' | 'NO_ABC'

export type PolicyUrgency =
  | 'critica'
  | 'alta'
  | 'media'
  | 'baixa'
  | 'ok'
  | 'reposicao_minima'
  | 'nao_repor'

/** Dias de cobertura-alvo por curva. Curva C não usa target de dias (ver MIN_REPLENISH_QTY_C). */
export const COVERAGE_TARGET_DAYS: Record<'A' | 'B' | 'NEW', number> = {
  A: 90,
  B: 30,
  NEW: 30,
}

/**
 * Reposição mínima quando estoque=0 e houve venda recente, na ausência de
 * MOQ/grade cadastrada. Usada pela Curva C e também por NO_ABC (mesma
 * política conservadora — ver resolvePolicyCurve).
 */
export const MIN_REPLENISH_QTY_C = 1

/**
 * SKU com menos dias que isso desde product_variations.created_at é
 * tratado como "Novo" (target 30 dias), independente de já ter ou não
 * classificação em mv_abc_by_revenue. Depois dessa janela, um SKU sem
 * classificação ABC (produto antigo sem vendas suficientes para entrar
 * em mv_abc_by_revenue) deixa de ser "Novo" e passa para NO_ABC — não
 * fica "Novo" para sempre.
 */
export const NEW_PRODUCT_MAX_AGE_DAYS = 30

/**
 * Limiares de urgência por cobertura atual (dias), em ordem de checagem.
 * Curva B e Curva NEW reutilizam os mesmos limiares (política B), por
 * indicação explícita: "pode usar a lógica proporcional do B inicialmente".
 */
export const URGENCY_THRESHOLDS_A = [
  { maxDays: 15, urgency: 'critica' as const },
  { maxDays: 30, urgency: 'alta' as const },
  { maxDays: 60, urgency: 'media' as const },
  { maxDays: 90, urgency: 'baixa' as const, exclusive: true }, // >60 e <90
]

export const URGENCY_THRESHOLDS_B = [
  { maxDays: 7, urgency: 'critica' as const },
  { maxDays: 15, urgency: 'alta' as const },
  { maxDays: 30, urgency: 'media' as const, exclusive: true }, // >15 e <30
]

/**
 * Ordem de prioridade de exibição (menor = primeiro). Combinações fora
 * do mapa caem no "restantes" (PRIORITY_RESTANTES); Curva C e NO_ABC são
 * sempre as últimas, com prioridade fixa (PRIORITY_CURVA_C), independente
 * da própria urgência interna delas — ambas seguem a mesma política
 * conservadora.
 */
export const PRIORITY_ORDER: Record<string, number> = {
  'A|critica': 1,
  'A|alta': 2,
  'A|media': 3,
  'A|baixa': 4,
  'NEW|critica': 5,
  'NEW|alta': 6,
  'B|critica': 7,
  'B|alta': 8,
}

export const PRIORITY_RESTANTES = 9
export const PRIORITY_CURVA_C = 10

export const CURVE_LABELS: Record<PolicyCurve, string> = {
  A: 'A',
  B: 'B',
  C: 'C',
  NEW: 'Novo',
  NO_ABC: 'Sem ABC',
}

export const URGENCY_LABELS: Record<PolicyUrgency, string> = {
  critica: 'Crítica',
  alta: 'Alta',
  media: 'Média',
  baixa: 'Baixa',
  ok: 'OK',
  reposicao_minima: 'Reposição mínima',
  nao_repor: 'Não repor',
}
