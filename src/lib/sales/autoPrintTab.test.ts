import { describe, it, expect, vi } from 'vitest'
import { createAutoPrintController, type PrintWindowLike } from './autoPrintTab'

function fakeWindow(): PrintWindowLike & { writes: string[] } {
  const writes: string[] = []
  const win: PrintWindowLike & { writes: string[] } = {
    closed: false,
    writes,
    location: { href: '' },
    close() {
      win.closed = true
    },
    document: {
      write(html: string) {
        writes.push(html)
      },
    },
  }
  return win
}

describe('createAutoPrintController', () => {
  it('finalizar retirada/entrega com sucesso — redireciona a aba já aberta para o comprovante', () => {
    const win = fakeWindow()
    const openBlankWindow = vi.fn(() => win)
    const controller = createAutoPrintController({ openBlankWindow })

    controller.handleFinalizarClick()
    expect(openBlankWindow).toHaveBeenCalledTimes(1)

    const redirected = controller.redirectToReceipt('/vendas/42/comprovante')
    expect(redirected).toBe(true)
    expect(win.location.href).toBe('/vendas/42/comprovante')
    expect(win.closed).toBe(false)
  })

  it('erro na criação da venda — reset() fecha a aba, nada é impresso', () => {
    const win = fakeWindow()
    const controller = createAutoPrintController({ openBlankWindow: () => win })

    controller.handleFinalizarClick()
    controller.reset()

    expect(win.closed).toBe(true)
    // Depois do reset, não há mais aba pra redirecionar — nenhuma impressão acontece.
    const redirected = controller.redirectToReceipt('/vendas/42/comprovante')
    expect(redirected).toBe(false)
    expect(win.location.href).toBe('') // nunca navegou pra lugar nenhum
  })

  it('clique duplo rápido não abre duas abas (impressão concorrente)', () => {
    const openBlankWindow = vi.fn(() => fakeWindow())
    const controller = createAutoPrintController({ openBlankWindow })

    controller.handleFinalizarClick()
    controller.handleFinalizarClick()
    controller.handleFinalizarClick()

    expect(openBlankWindow).toHaveBeenCalledTimes(1)
  })

  it('depois de reset() (ex.: erro), um novo clique volta a poder abrir aba — permite tentar de novo', () => {
    const openBlankWindow = vi.fn(() => fakeWindow())
    const controller = createAutoPrintController({ openBlankWindow })

    controller.handleFinalizarClick()
    controller.reset()
    controller.handleFinalizarClick()

    expect(openBlankWindow).toHaveBeenCalledTimes(2)
  })

  it('pop-up bloqueado pelo navegador (openBlankWindow retorna null) — redirectToReceipt não quebra, retorna false', () => {
    const controller = createAutoPrintController({ openBlankWindow: () => null })

    controller.handleFinalizarClick()
    const redirected = controller.redirectToReceipt('/vendas/42/comprovante')

    expect(redirected).toBe(false)
  })

  it('usuário fecha a aba manualmente antes da venda terminar — redirectToReceipt detecta e não quebra', () => {
    const win = fakeWindow()
    const controller = createAutoPrintController({ openBlankWindow: () => win })

    controller.handleFinalizarClick()
    win.closed = true // usuário fechou a aba enquanto o fetch ainda estava em andamento

    const redirected = controller.redirectToReceipt('/vendas/42/comprovante')
    expect(redirected).toBe(false)
  })

  it('redirectToReceipt nunca é chamado antes de handleFinalizarClick — não navega nem quebra', () => {
    const controller = createAutoPrintController({ openBlankWindow: () => fakeWindow() })
    const redirected = controller.redirectToReceipt('/vendas/42/comprovante')
    expect(redirected).toBe(false)
  })

  it('openBlankWindow lançando exceção (ex.: ambiente restrito) não propaga — trata como bloqueado', () => {
    const controller = createAutoPrintController({
      openBlankWindow: () => {
        throw new Error('SecurityError')
      },
    })

    expect(() => controller.handleFinalizarClick()).not.toThrow()
    expect(controller.redirectToReceipt('/vendas/42/comprovante')).toBe(false)
  })

  it('mostra uma mensagem de carregamento na aba enquanto a venda ainda está sendo criada', () => {
    const win = fakeWindow()
    const controller = createAutoPrintController({ openBlankWindow: () => win })

    controller.handleFinalizarClick()

    expect(win.writes).toHaveLength(1)
    expect(win.writes[0]).toContain('Gerando comprovante')
  })
})
