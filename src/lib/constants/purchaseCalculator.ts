/**
 * Calculadora de Compra e Alavancagem — constantes.
 *
 * Central para não espalhar "magic numbers" pelo service/UI, seguindo o
 * mesmo padrão de src/lib/constants/purchasePolicy.ts. Tudo manual nesta
 * V1 — nenhum valor aqui vem do banco.
 */

/** Folga mínima padrão sugerida ao abrir a calculadora (editável no formulário). */
export const DEFAULT_MINIMUM_COVERAGE_RATIO = 1.5

/** Múltiplo da folga mínima acima do qual o resultado é tratado como "confortável" (ok) em vez de "apertado" (atenção), só para o selo visual — não afeta a recomendação em si. */
export const COMFORTABLE_COVERAGE_MULTIPLIER = 1.2
