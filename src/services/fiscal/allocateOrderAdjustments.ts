/**
 * Rateio determinístico de ajustes de NÍVEL DO PEDIDO (desconto/acréscimo/
 * frete) entre múltiplos itens — Fase Fiscal 4I (hardening pré-produção).
 *
 * MOTIVAÇÃO: o schema NFe/NFCe (mesmo tipo complexo `det/prod`, confirmado
 * por leitura direta de campos.focusnfe.com.br/nfe/NotaFiscalXML.html) só
 * representa `valor_frete`/`valor_outras_despesas`/`valor_desconto` em
 * nível de ITEM — nunca em nível de documento. A versão anterior
 * (`buildNfcePayload.ts`, Fase Fiscal 4H) atribuía o valor total de cada
 * ajuste inteiramente ao PRIMEIRO item — seguro só para venda de item
 * único (o caso real corrigido então, venda 626), mas incorreto pra venda
 * com múltiplos itens: um desconto de pedido podia superar o valor do
 * primeiro item sozinho, e a distribuição não refletia nenhuma lógica de
 * negócio real. Este módulo substitui aquela estratégia por rateio
 * proporcional ao valor de cada item.
 *
 * ─── Estratégia: rateio proporcional por valor (peso = valor_bruto do
 * item MENOS o desconto que o próprio item já tinha) ───────────────────
 *
 * Cada item recebe uma fração de cada ajuste proporcional ao seu peso
 * dentro do total de pesos — itens mais caros absorvem mais desconto/
 * acréscimo/frete que itens mais baratos, o que é a única base objetiva
 * disponível neste ERP (não há sinal de negócio pra decidir de outra
 * forma, ex.: "este desconto era só do produto X").
 *
 * ─── Prova matemática (exatidão de centavos + nunca item negativo) ──────
 *
 * Tudo é feito em CENTAVOS (inteiros), nunca em ponto flutuante — evita
 * perda de centavos por arredondamento acumulado.
 *
 * Método do maior resto (Largest Remainder / Hare-Niemeyer, apportionment
 * clássico): para pesos w_1..w_n e um total T (inteiro, em centavos):
 *   1. raw_i = T · w_i / W, onde W = Σw_i
 *   2. floor_i = ⌊raw_i⌋
 *   3. resto = T − Σfloor_i  (sempre um inteiro, 0 ≤ resto < n)
 *   4. os `resto` itens com MAIOR parte fracionária (raw_i − floor_i)
 *      recebem +1 centavo cada, em ordem de fração decrescente, empate
 *      desfeito por índice crescente (determinístico, nunca ambíguo)
 *
 * EXATIDÃO: Σfloor_i + resto = Σfloor_i + (T − Σfloor_i) = T, sempre,
 * por construção — nunca perde nem sobra 1 centavo, para qualquer T/pesos.
 *
 * NUNCA NEGATIVO (quando aplicado a desconto, T ≤ W é exigido pelo
 * chamador — `applyOrderLevelAdjustments` lança `FiscalBuildError` se
 * T > W): floor_i ≤ raw_i = T·w_i/W ≤ W·w_i/W = w_i (usa T ≤ W) — ou
 * seja, ANTES do arredondamento, a alocação de cada item nunca excede seu
 * próprio peso. O arredondamento (+1) só é aplicado a um item cuja parte
 * fracionária é > 0 — mas se floor_i já fosse igual a w_i (o teto),
 * raw_i ≤ w_i force raw_i = w_i exatamente, o que dá parte fracionária
 * ZERO (w_i é sempre um inteiro de centavos) — um item nessa condição
 * NUNCA é escolhido para o +1 (fração 0 nunca vence o desempate por maior
 * fração, exceto se TODOS os itens estiverem nessa condição
 * simultaneamente, o que só acontece quando T = W exatamente — e nesse
 * caso resto = T − Σfloor_i = T − ΣW·w_i/W = T − W = 0, ou seja, não há
 * nenhum centavo extra pra distribuir). Logo: floor_i + (0 ou 1) ≤ w_i
 * sempre — nenhum item recebe mais do que seu próprio peso permite.
 *
 * ─── Peso zero / soma de pesos zero ──────────────────────────────────────
 * Se todos os pesos forem 0 (ex.: item já com desconto igual ao valor
 * bruto), o rateio proporcional degeneraria em divisão por zero — nesse
 * caso o rateio cai pra partes IGUAIS (peso 1 pra cada item), ainda com
 * exatidão de centavos garantida pelo mesmo método. Só é atingível pra
 * desconto se T também for 0 (a checagem T ≤ W barra qualquer T > 0
 * quando W = 0).
 */

export interface RateableItemPayload {
  valor_bruto: number
  valor_desconto?: number
  valor_frete?: number
  valor_outras_despesas?: number
}

export interface OrderLevelAdjustments {
  discountAmount: number
  surchargeAmount: number
  shippingCharged: number
}

export class FiscalAllocationError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'FiscalAllocationError'
  }
}

function toCents(value: number): number {
  return Math.round(value * 100)
}

function fromCents(cents: number): number {
  return Math.round(cents) / 100
}

/**
 * Distribui `totalCents` (inteiro) entre `weights.length` posições,
 * proporcionalmente aos pesos — SEMPRE soma exatamente `totalCents`,
 * nunca perde/sobra centavo. Ver prova matemática no comentário do
 * arquivo. Pesos negativos não são esperados (o chamador nunca produz
 * peso negativo) — não defendido aqui de propósito, é responsabilidade
 * do chamador.
 */
export function allocateProportionalCents(totalCents: number, weights: number[]): number[] {
  if (weights.length === 0) return []
  if (totalCents === 0) return weights.map(() => 0)

  const totalWeight = weights.reduce((sum, w) => sum + w, 0)
  // Sem nenhuma base de valor pra ratear (todos os pesos zerados) — cai
  // pra partes iguais, nunca divide por zero.
  const effectiveWeights = totalWeight > 0 ? weights : weights.map(() => 1)
  const effectiveTotalWeight = totalWeight > 0 ? totalWeight : weights.length

  const raw = effectiveWeights.map((w) => (totalCents * w) / effectiveTotalWeight)
  const floors = raw.map(Math.floor)
  const allocated = floors.reduce((sum, v) => sum + v, 0)
  const remainder = totalCents - allocated

  const byFraction = raw
    .map((r, i) => ({ i, frac: r - floors[i] }))
    .sort((a, b) => b.frac - a.frac || a.i - b.i)

  for (let k = 0; k < remainder; k++) {
    floors[byFraction[k].i] += 1
  }

  return floors
}

/**
 * Aplica desconto/acréscimo/frete de NÍVEL DO PEDIDO aos itens do payload,
 * via rateio proporcional (ver prova matemática no topo do arquivo).
 * Muta os itens recebidos (mesmo padrão da versão anterior, Fase 4H).
 *
 * - `discountAmount` SOMA ao `valor_desconto` que cada item já tinha
 *   (preserva desconto por item já existente, nunca substitui).
 * - `surchargeAmount`/`shippingCharged` viram `valor_outras_despesas`/
 *   `valor_frete` de cada item — campos que este ERP nunca populava por
 *   item antes deste rateio, então são atribuídos direto (sem soma).
 * - Lança `FiscalAllocationError` se `discountAmount` exceder a soma dos
 *   pesos (valor total dos itens líquido de desconto por item) — nunca
 *   gera item com desconto maior que seu próprio valor bruto (prova
 *   matemática garante isso quando a checagem abaixo passa).
 */
export function applyOrderLevelAdjustments<T extends RateableItemPayload>(
  items: T[],
  adjustments: OrderLevelAdjustments,
): void {
  if (items.length === 0) return
  const { discountAmount, surchargeAmount, shippingCharged } = adjustments
  if (discountAmount === 0 && surchargeAmount === 0 && shippingCharged === 0) return

  const weightsCents = items.map((item) => Math.max(0, toCents(item.valor_bruto) - toCents(item.valor_desconto ?? 0)))
  const totalWeightCents = weightsCents.reduce((sum, w) => sum + w, 0)

  const discountCents = toCents(discountAmount)
  if (discountCents > totalWeightCents) {
    throw new FiscalAllocationError(
      `applyOrderLevelAdjustments: desconto do pedido (R$ ${discountAmount.toFixed(2)}) excede o valor total dos itens já líquido de desconto por item (R$ ${fromCents(totalWeightCents).toFixed(2)}) — geraria item com desconto negativo, dado inconsistente.`,
    )
  }

  if (discountCents > 0) {
    const allocation = allocateProportionalCents(discountCents, weightsCents)
    items.forEach((item, idx) => {
      if (allocation[idx] > 0) {
        item.valor_desconto = fromCents(toCents(item.valor_desconto ?? 0) + allocation[idx])
      }
    })
  }

  if (surchargeAmount > 0) {
    const allocation = allocateProportionalCents(toCents(surchargeAmount), weightsCents)
    items.forEach((item, idx) => {
      if (allocation[idx] > 0) item.valor_outras_despesas = fromCents(allocation[idx])
    })
  }

  if (shippingCharged > 0) {
    const allocation = allocateProportionalCents(toCents(shippingCharged), weightsCents)
    items.forEach((item, idx) => {
      if (allocation[idx] > 0) item.valor_frete = fromCents(allocation[idx])
    })
  }
}
