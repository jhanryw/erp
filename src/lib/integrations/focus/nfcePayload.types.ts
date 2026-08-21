/**
 * Tipos do payload de emissão de NFC-e (`POST /v2/nfce`) — Fase Fiscal 4E.
 *
 * Fonte primária: OpenAPI real da Focus, obtido via `curl` bruto (user-agent
 * de browser — o CDN de `doc.focusnfe.com.br` bloqueia requisição sem UA)
 * contra `https://doc.focusnfe.com.br/reference/emitir_nfce.md`, que devolve
 * o spec completo em JSON embutido no markdown — parseado com `python3`,
 * nunca resumo de IA (mesma disciplina da Fase Fiscal 2A/2B/4).
 *
 * ─── Diferença de tipagem observada vs. `nfePayload.types.ts` (NF-e) ──────
 *
 * O schema REAL de NFC-e (`NFCeRequest`/`ItemNFCe`) tipa como STRING vários
 * campos que o `nfePayload.types.ts` (NF-e) tipa como `number`:
 * `presenca_comprador`, `modalidade_frete`, `local_destino`,
 * `indicador_inscricao_estadual_destinatario`, `icms_origem`, `numero_item`.
 * Exemplo do schema real: `"presenca_comprador": {"type": "string",
 * "example": "1"}`. Este arquivo segue FIELMENTE a evidência de NFC-e (string
 * onde o schema documenta string) — não copia a tipagem de NF-e por
 * conveniência. Isto pode indicar que o `nfePayload.types.ts` existente tem
 * uma tipagem imprecisa (não confirmada nesta rodada — fora de escopo desta
 * fase corrigir NF-e já em produção de testes; ver nota no relatório da
 * fase) — sinalizado aqui, não corrigido silenciosamente.
 *
 * ─── Campos tributários por item (PIS/COFINS/IPI/IBS-CBS) ─────────────────
 *
 * O OpenAPI PÚBLICO de NFC-e é deliberadamente abreviado (a própria
 * descrição do schema diz: "A NFC-e possui centenas de campos... campos de
 * uso mais comum abaixo", remetendo pra
 * `campos.focusnfe.com.br/nfe/NotaFiscalXML.html" — a MESMA página de
 * referência já usada pra confirmar os nomes de campo de NF-e, cujo XSD
 * nacional (`leiauteNFe_v4.00.xsd`) define UM ÚNICO tipo complexo
 * `det/prod`+`det/imposto` reaproveitado tanto por NF-e (mod 55) quanto por
 * NFC-e (mod 65) — não são schemas XML independentes. Por isso os campos
 * `pis_*`/`cofins_*`/`ibs_cbs_*`/`cbs_*` abaixo reaproveitam
 * EXATAMENTE os mesmos nomes já confirmados em `nfePayload.types.ts`
 * (mesma fonte, mesma página). **Isto é inferência fundamentada, não
 * confirmação empírica específica de NFC-e** — nenhum XML real de NFC-e
 * autorizado foi usado como prova (diferente do que foi feito pra NF-e na
 * Fase 2B, com 2 XMLs reais). Tratar como blocker de confirmação antes da
 * primeira emissão real de homologação NFC-e (mesmo padrão já usado pra
 * `forma_pagamento`, ver `nfcePaymentRules` em `buildNfcePayload.ts`).
 *
 * ─── IPI: DELIBERADAMENTE AUSENTE (achado real, primeira emissão real de
 * homologação, venda 626) ───────────────────────────────────────────────
 * `ipi_situacao_tributaria`/`ipi_codigo_enquadramento_legal` existiam aqui
 * (copiados de `nfePayload.types.ts` por analogia, sem confirmação
 * própria de NFC-e — exatamente o risco que a nota acima já sinalizava)
 * e causaram rejeição real da SEFAZ: `SEFAZ 742 — "NFC-e com grupo do
 * IPI"`. O modelo 65 (NFC-e) não aceita o grupo IPI de forma alguma,
 * mesmo com CST "não tributado" (53) — diferente de NF-e (mod 55), onde
 * o grupo é enviado normalmente. Removidos do tipo (não apenas
 * opcionais) para que nenhum builder consiga montá-los por engano.
 *
 * ─── Deliberadamente NÃO implementado nesta fase ───────────────────────────
 * `codigo_unico` (contingência offline), `informacoes_adicionais_contribuinte`,
 * campos de cartão integrado (`tipo_integracao`/`nome_credenciadora`/
 * `numero_autorizacao` — mesma decisão já tomada pra NF-e: este ERP não tem
 * dado fiscal confiável de credenciadora).
 */

export interface FocusFormaPagamentoNfce {
  /** tPag — ver nota de confirmação pendente em `buildNfcePayload.ts`. */
  forma_pagamento: string
  valor_pagamento: number
  /** tBand — mesma lógica de `resolveBandeiraOperadora` já usada em NF-e. */
  bandeira_operadora?: string
}

export interface FocusNfceItemPayload {
  /** STRING no schema real de NFC-e (diferente de NF-e, que usa number) — ver nota do arquivo. */
  numero_item: string
  codigo_produto: string
  descricao: string
  cfop: string
  unidade_comercial: string
  /** STRING no schema real de NFC-e. */
  icms_origem: string
  quantidade_comercial: number
  /**
   * Unidade/quantidade TRIBUTÁVEL — campo exigido pelo schema de NFC-e sem
   * equivalente usado no builder de NF-e hoje (este ERP não modela unidade
   * fiscal distinta da unidade comercial — um produto tem só
   * `unidade_med`). Nunca inventamos uma conversão: tributável = comercial,
   * mesmo valor, mesma unidade — reflete exatamente o que o cadastro de
   * produto tem, sem fabricar um fator de conversão.
   */
  quantidade_tributavel: number
  unidade_tributavel: string
  valor_unitario_comercial: number
  valor_unitario_tributavel: number
  valor_bruto: number
  valor_desconto?: number
  codigo_ncm: string

  icms_situacao_tributaria: string

  pis_situacao_tributaria: string
  pis_base_calculo: number
  pis_aliquota_porcentual: number
  pis_valor: number

  cofins_situacao_tributaria: string
  cofins_base_calculo: number
  cofins_aliquota_porcentual: number
  cofins_valor: number

  ibs_cbs_situacao_tributaria: string
  ibs_cbs_classificacao_tributaria: string
  ibs_cbs_base_calculo: number
  ibs_uf_aliquota: number
  ibs_uf_valor: number
  ibs_mun_aliquota: number
  ibs_mun_valor: number
  ibs_valor_total: number
  cbs_aliquota: number
  cbs_valor: number

  /**
   * Valor total de tributos do item (Lei da Transparência Fiscal) — campo
   * OPCIONAL no schema real, e este ERP não calcula carga tributária
   * estimada (CSOSN 102 é "sem permissão de crédito", sem base pra esse
   * número). Deliberadamente OMITIDO em vez de enviar um `0` fabricado —
   * diferente de PIS/COFINS/IBS-CBS (onde `0` é o valor real confirmado por
   * XML), aqui não há evidência nenhuma do valor correto.
   */
  valor_total_tributos?: number
}

export interface FocusNfcePayload {
  cnpj_emitente: string
  /** ISO 8601 com timezone, diferença máxima de 5min do horário do servidor Focus — gerado no momento da transmissão, nunca antes. */
  data_emissao: string
  /** STRING no schema real: "1"=Presencial, "4"=Entrega a domicílio — únicos valores que NFC-e aceita (diferente do intervalo completo de NF-e). */
  presenca_comprador: '1' | '4'
  /** STRING no schema real. */
  modalidade_frete: string
  /** STRING no schema real: "1"=Interna, "2"=Interestadual, "3"=Exterior. */
  local_destino: string
  natureza_operacao: string

  /** Só enviado quando há CPF/CNPJ do destinatário — nunca exigido (consumidor não identificado é o caminho feliz de balcão). */
  nome_destinatario?: string
  cpf_destinatario?: string
  cnpj_destinatario?: string
  /** "1"=Contribuinte ICMS, "2"=Isento, "9"=Não contribuinte — só relevante quando cnpj_destinatario presente (mesma lógica de NF-e). */
  indicador_inscricao_estadual_destinatario?: string

  items: FocusNfceItemPayload[]
  formas_pagamento: FocusFormaPagamentoNfce[]

  /** Opcional — Focus atribui automaticamente quando omitido (mesmo padrão de NF-e). Nunca enviado por este ERP. */
  numero?: string
  serie?: string
}
