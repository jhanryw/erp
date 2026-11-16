/**
 * Normalização ÚNICA da chave de acesso devolvida pela Focus (NF-e e NFC-e).
 * Ver o relato completo do achado (venda 626 NFC-e; venda 1243 NF-e — Postgres:
 * "value too long for type character(44)" em fiscal_documents.access_key, a ÚNICA coluna
 * CHAR(44) do schema) no comentário original preservado abaixo.
 */

export class FocusAccessKeyError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'FocusAccessKeyError'
  }
}

/**
 * Normaliza `chave_nfe` da resposta Focus pra chave de acesso real (44
 * dígitos numéricos — `fiscal_documents.access_key CHAR(44)`) — achado
 * real (venda 626, tentativa 3: Postgres rejeitou com "value too long for
 * type character(44)"). CONFIRMADO por leitura direta (curl bruto, não
 * resumo de IA) do exemplo oficial `"NFCeAutorizada"` em
 * `doc.focusnfe.com.br/reference/emitir_nfce.md`:
 * `"chave_nfe": "NFe41190612345678000123650010000000121743484310"` — 47
 * caracteres: prefixo literal `"NFe"` (3 chars) + 44 dígitos numéricos (o
 * mesmo valor, sem o prefixo, reaparece em `qrcode_url` — `p=
 * 41190612345678000123650010000000121743484310|...`). O mesmo padrão foi
 * confirmado em `emitir_nfe.md` (exemplo `"NFeAutorizada"`) — o bug
 * EXISTE IGUALMENTE do lado de NF-e (`submitNfeHomologacao.ts`), mas não
 * foi corrigido aqui — fora de escopo desta correção (NFC-e only).
 *
 * NUNCA trunca silenciosamente pra caber em 44 chars — trunca seria pior
 * que o erro do Postgres (uma chave de acesso ERRADA persistida com
 * aparência de válida). Se, depois de remover um prefixo `"NFe"` literal,
 * o resultado não for exatamente 44 dígitos numéricos, lança com uma
 * mensagem diagnóstica clara — nunca deixa a coluna receber lixo.
 */
export function extractFocusAccessKey(chaveNfe: string | null | undefined): string {
  if (!chaveNfe) {
    throw new FocusAccessKeyError('Focus retornou status "autorizado" sem chave_nfe na resposta — não é seguro persistir a autorização sem a chave de acesso.')
  }
  const semPrefixo = chaveNfe.startsWith('NFe') ? chaveNfe.slice(3) : chaveNfe
  if (!/^\d{44}$/.test(semPrefixo)) {
    throw new FocusAccessKeyError(
      `chave_nfe da Focus não corresponde a uma chave de acesso válida (esperado 44 dígitos numéricos após remover um eventual prefixo "NFe"; recebido "${chaveNfe}" — ${semPrefixo.length} caractere(s) depois de normalizar) — nada foi persistido.`,
    )
  }
  return semPrefixo
}
