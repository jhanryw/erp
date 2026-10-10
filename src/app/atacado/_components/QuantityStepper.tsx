'use client'

import { Minus, Plus } from 'lucide-react'

interface Props {
  /** Quantidade atual — só para exibição e para desabilitar os botões. */
  value: number
  max: number
  /**
   * Passo (+1/-1). O pai aplica o passo sobre o estado MAIS RECENTE (atualização funcional): cliques rápidos,
   * que chegam antes de um novo render, nunca perdem incrementos.
   */
  onStep: (delta: 1 | -1) => void
  /** Nome acessível do item (ex.: "Calcinha Rosa P/M"). */
  label: string
  disabled?: boolean
}

/**
 * Seletor de quantidade do atacado — ÚNICO componente (página de produto e carrinho).
 * Contraste WCAG AA: número em cinza-900 (17:1) sobre branco, borda cinza-500 (4,8:1), botões de 40 px (alvo de toque).
 * Desabilitado = fundo cinza e ícone apagado (nunca confundível com ativo). Nunca ultrapassa `max`.
 */
export function QuantityStepper({ value, max, onStep, label, disabled = false }: Props) {
  const btn =
    'flex h-10 w-10 items-center justify-center text-gray-800 transition-colors hover:bg-gray-100 active:bg-gray-200 ' +
    'disabled:cursor-not-allowed disabled:bg-gray-50 disabled:text-gray-400 disabled:hover:bg-gray-50'

  return (
    <div
      role="group"
      aria-label={`Quantidade de ${label}`}
      className={`inline-flex shrink-0 items-center overflow-hidden rounded-lg border bg-white ${disabled ? 'border-gray-300' : 'border-gray-500'}`}
    >
      <button type="button" aria-label={`Diminuir ${label}`} disabled={disabled || value <= 0} onClick={() => onStep(-1)} className={btn}>
        <Minus className="h-4 w-4" aria-hidden />
      </button>
      <span
        aria-live="polite"
        className={`min-w-[2.5rem] px-1 text-center text-base font-semibold tabular-nums ${disabled ? 'text-gray-400' : 'text-gray-900'}`}
      >
        {value}
      </span>
      <button type="button" aria-label={`Aumentar ${label}`} disabled={disabled || value >= max} onClick={() => onStep(1)} className={btn}>
        <Plus className="h-4 w-4" aria-hidden />
      </button>
    </div>
  )
}
