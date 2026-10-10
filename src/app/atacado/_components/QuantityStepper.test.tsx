// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, fireEvent, cleanup } from '@testing-library/react'
import { QuantityStepper } from './QuantityStepper'

afterEach(cleanup)

describe('QuantityStepper', () => {
  it('número com cor explícita escura (nunca herda o tema) e rótulos acessíveis', () => {
    render(<QuantityStepper value={3} max={5} label="Calcinha Rosa P/M" onStep={() => {}} />)
    const number = screen.getByText('3')
    expect(number.className).toContain('text-gray-900')
    expect(screen.getByRole('group', { name: 'Quantidade de Calcinha Rosa P/M' })).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Aumentar Calcinha Rosa P/M' })).toBeTruthy()
  })

  it('emite passos +1/-1 e desabilita nos limites (estoque e zero)', () => {
    const onStep = vi.fn()
    const { rerender } = render(<QuantityStepper value={4} max={5} label="x" onStep={onStep} />)
    fireEvent.click(screen.getByRole('button', { name: 'Aumentar x' }))
    expect(onStep).toHaveBeenLastCalledWith(1)
    fireEvent.click(screen.getByRole('button', { name: 'Diminuir x' }))
    expect(onStep).toHaveBeenLastCalledWith(-1)

    rerender(<QuantityStepper value={5} max={5} label="x" onStep={onStep} />)
    expect((screen.getByRole('button', { name: 'Aumentar x' }) as HTMLButtonElement).disabled).toBe(true)

    rerender(<QuantityStepper value={0} max={5} label="x" onStep={onStep} />)
    expect((screen.getByRole('button', { name: 'Diminuir x' }) as HTMLButtonElement).disabled).toBe(true)
  })

  it('desabilitado: ambos os botões inativos e visual claramente apagado', () => {
    const onStep = vi.fn()
    render(<QuantityStepper value={0} max={5} label="x" disabled onStep={onStep} />)
    for (const b of screen.getAllByRole('button')) expect((b as HTMLButtonElement).disabled).toBe(true)
    expect(screen.getByText('0').className).toContain('text-gray-400')
  })
})
