// Comprovante não fiscal — impressão automática ao finalizar a venda.
//
// window.open() chamado DEPOIS de um `await` (ex.: dentro do onSubmit, após
// o fetch de criação da venda) é bloqueado como pop-up pela maioria dos
// navegadores — Safari em particular não perdoa nem um microtask de atraso.
// O padrão pra contornar isso sem extensão/serviço local: abrir uma aba
// about:blank de forma SÍNCRONA, ainda dentro do handler de clique original
// (gesto de usuário "fresco"), e só depois — já com a venda criada — trocar
// a location dessa aba pra URL do comprovante.
//
// Lógica extraída da página em um controller puro (injeção do
// `openBlankWindow`) para ser testável sem DOM real — src/app/(dashboard)/
// vendas/nova/page.tsx só instancia e chama os métodos.

export interface PrintWindowLike {
  closed: boolean
  close(): void
  document: { write(html: string): void }
  location: { href: string }
}

export interface AutoPrintDeps {
  openBlankWindow: () => PrintWindowLike | null
}

export interface AutoPrintController {
  /** Chamar de forma SÍNCRONA no onClick do botão de finalizar — nunca depois de um await. */
  handleFinalizarClick(): void
  /** Fecha a aba (se existir) e libera o guard — chamar em QUALQUER caminho de erro/validação inválida. */
  reset(): void
  /** Só chamar depois da venda criada com sucesso. Retorna false se não havia aba (bloqueada/fechada pelo usuário). */
  redirectToReceipt(url: string): boolean
}

const LOADING_HTML =
  '<title>Gerando comprovante…</title><body style="font-family: sans-serif; padding: 24px; color: #555;">Gerando comprovante…</body>'

export function createAutoPrintController(deps: AutoPrintDeps): AutoPrintController {
  let opening = false
  let win: PrintWindowLike | null = null

  return {
    handleFinalizarClick() {
      // Guard síncrono e independente de qualquer estado de submit do
      // formulário (que só é atualizado depois, dentro de onSubmit,
      // possivelmente após validação assíncrona do react-hook-form) — sem
      // isto, um clique duplo rápido abriria duas abas about:blank antes do
      // primeiro clique terminar de processar.
      if (opening) return
      opening = true
      try {
        win = deps.openBlankWindow()
        win?.document.write(LOADING_HTML)
      } catch {
        win = null
      }
    },

    reset() {
      try {
        win?.close()
      } catch {
        // Aba já pode ter sido fechada pelo usuário — ignora.
      }
      win = null
      opening = false
    },

    redirectToReceipt(url: string): boolean {
      if (win && !win.closed) {
        win.location.href = url
        return true
      }
      return false
    },
  }
}
