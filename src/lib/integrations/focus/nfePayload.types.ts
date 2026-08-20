/**
 * Tipos do payload de emissão de NF-e (`POST /v2/nfe`) — Fase Fiscal 2A.
 *
 * Só os campos que este ERP efetivamente monta (revenda de mercadoria de
 * terceiros, consumidor final, CRT 1/4). Nomes de campo confirmados em
 * campos.focusnfe.com.br/nfe/NotaFiscalXML.html (pesquisa da Fase Fiscal
 * 2A — ver relatório da fase, seção C, pra fonte de cada um).
 *
 * NENHUM código deste projeto chama `POST /v2/nfe` ainda — este tipo
 * existe só pra `buildNfePayload` montar e o preview mostrar. A chamada
 * real fica pra Fase Fiscal 2B/3.
 *
 * Sub-campos de valor tributário — CORRIGIDO na Fase Fiscal 2B com
 * evidência empírica: um XML de NF-e real, modelo 55, autorizado pela
 * SEFAZ (protocolo/cStat=100), emitido por uma empresa CRT=4 em operação
 * equivalente à nossa, mostra que PIS/COFINS CST=49 SEMPRE incluem
 * `vBC`/`pPIS ou pCOFINS`/`vPIS ou vCOFINS` explicitamente como `0.00` —
 * NUNCA omitidos. A fase anterior (2A) tinha decidido omitir esses
 * sub-campos por analogia (raciocínio razoável, mas sem prova real) —
 * essa decisão está REVERTIDA aqui. IPI permanece diferente: o grupo
 * `IPINT` (IPI não tributado) do XML real não tem NENHUM sub-campo de
 * valor — só `CST` — confirmando que omitir `ipi_base_calculo`/
 * `ipi_aliquota`/`ipi_valor` para CST=53 continua correto.
 *
 * Isto é uma pista fiscal (dado do XML nacional), não necessariamente o
 * nome exato do campo Focus — os nomes de campo usados aqui continuam os
 * confirmados em campos.focusnfe.com.br (Fase 2A), nunca os nomes de tag
 * do XML (`vBC`/`pPIS`/`vPIS` são tags XML, não os nomes JSON da Focus).
 *
 * IBS/CBS — RECONFIRMADO na Fase Fiscal 2B por leitura DIRETA do HTML bruto
 * de campos.focusnfe.com.br/nfe/NotaFiscalXML.html (via `curl`, sem
 * intermediário de IA que poderia parafrasear nomes de campo — a pesquisa
 * anterior usava só `WebFetch`, que resume com um modelo, risco real de
 * erro de transcrição). Grep direto no JSON de definição de campos da
 * própria página confirmou, com `required`/`tag` originais:
 *   ibs_cbs_situacao_tributaria (required=true, tag CST)
 *   ibs_cbs_classificacao_tributaria (required=true, tag cClassTrib)
 *   ibs_cbs_base_calculo (required=false, tag vBC)
 *   ibs_uf_aliquota (required=false, tag pIBSUF)
 *   ibs_uf_valor (required=false, tag vIBSUF)
 *   ibs_mun_aliquota (required=false, tag pIBSMun)
 *   ibs_mun_valor (required=false, tag vIBSMun)
 *   ibs_valor_total (required=false, tag vIBS — nome igual ao campo de
 *     TOTAL do documento, mas confirmado em escopo de ITEM pela posição no
 *     HTML, antes de `informacoes_adicionais_item`; Focus reaproveita o
 *     mesmo nome em dois escopos diferentes — resolvido pela posição/
 *     nesting, não por nome único)
 *   cbs_aliquota (required=false, tag pCBS)
 *   cbs_valor (required=false, tag vCBS)
 * Todos os valores calculados são enviados explicitamente como 0 (nunca
 * omitidos) — mesmo padrão confirmado pra PIS/COFINS pelos XMLs reais.
 * Nenhum total de documento (`ibs_uf_valor_total`/`ibs_mun_valor_total`/
 * `cbs_valor_total`) é enviado por este ERP — mesma decisão já tomada pra
 * `vProd`/`vNF` (deixar a Focus computar o total a partir dos itens).
 * `indFinal`→`consumidor_final`, `indIntermed`→`indicador_intermediario`.
 *
 * ─── Fechamento final (pós-Fase 2B) ──────────────────────────────────────
 * Por decisão do responsável pelo produto, os dois pontos antes listados
 * como "bloqueador residual — confirmar com Focus support" foram
 * considerados FECHADOS e não são mais tratados como pendência:
 *   1. `regime_tributario_emitente=4` pra emitente MEI — considerado
 *      confirmado (a doc de campos completa já documentava o valor 4
 *      explicitamente; a inconsistência era só a referência interativa da
 *      Focus não mostrar o mesmo valor numa leitura).
 *   2. Nomes de campo IBS/CBS listados acima — considerados confirmados
 *      (leitura direta do HTML bruto via `curl`, não resumo de IA).
 * Nenhuma mudança de comportamento decorre disso — o payload já enviava
 * `regime_tributario_emitente` espelhando o CRT e os campos IBS/CBS como
 * documentado; esta nota só remove esses dois itens da lista de
 * bloqueadores em relatórios futuros. O motor fiscal (este arquivo,
 * `buildNfePayload.ts`, `taxRules.ts`) está congelado a partir daqui —
 * qualquer ajuste tributário futuro é uma fase nova, não uma continuação
 * silenciosa desta.
 */

/**
 * Forma de pagamento — Fase Fiscal 3A. Campos confirmados por leitura
 * direta do HTML bruto de campos.focusnfe.com.br (JSON embutido na
 * própria página) E cross-checados contra o XSD oficial da SEFAZ
 * (`leiauteNFe_v4.00.xsd`) — nunca resumo de IA. `formas_pagamento[]` é
 * campo raiz do payload (0-100 entradas), campos ACHATADOS por item
 * (diferente do XML, que aninha os campos de cartão num grupo `card`) —
 * confirmado na doc da Focus.
 *
 * Deliberadamente OMITIDOS (nunca implementados nesta fase): `tipo_integracao`,
 * `cnpj_credenciadora`, `numero_autorizacao`, `cnpj_beneficiario`,
 * `id_terminal_pagamento` — este ERP não tem dado fiscal confiável de
 * credenciadora/integração (`sale_payments.acquirer` é texto livre, nunca
 * um CNPJ real), e `cnpj_credenciadora` só é exigido quando
 * `tipo_integracao='1'` — o caminho seguro é nunca enviar esse sub-bloco
 * inteiro, nunca inventar `tipo_integracao='2'` só pra evitar a exigência.
 * `descricao_pagamento` (só usado quando forma_pagamento='99') também não
 * é enviado — este ERP nunca produz forma_pagamento='99'.
 *
 * Também deliberadamente ausente: qualquer campo de parcelas — confirmado
 * no XSD oficial que `detPag`/`card` não tem campo de parcelas. `sale_payments.
 * installments` nunca chega aqui, fica só como dado interno do ERP.
 */
export interface FocusFormaPagamento {
  forma_pagamento: string
  valor_pagamento: number
  /** indPag — sempre '0' (à vista) neste ERP, ver paymentRules.ts. */
  indicador_pagamento: '0' | '1'
  /** tBand — só quando reconhecido ou "sabemos que há bandeira, não qual" (ver resolveBandeiraOperadora). Omitido quando não há dado de cartão algum. */
  bandeira_operadora?: string
}

export interface FocusNfeItemPayload {
  numero_item: number
  codigo_produto: string
  descricao: string
  cfop: string
  unidade_comercial: string
  quantidade_comercial: number
  valor_unitario_comercial: number
  valor_bruto: number
  valor_desconto?: number
  codigo_ncm: string
  cest?: string
  /** 'SEM GTIN' — este ERP não modela GTIN/EAN de produto (confirmado, nenhuma coluna existe). */
  codigo_barras_comercial: string

  icms_origem: number
  /** CSOSN (Simples Nacional/MEI) — unificado com CST no mesmo campo pela Focus, confirmado. */
  icms_situacao_tributaria: string

  pis_situacao_tributaria: string
  /** Sempre presentes e zerados quando pis_situacao_tributaria=49 — confirmado por XML real (ver comentário do arquivo). */
  pis_base_calculo: number
  pis_aliquota_porcentual: number
  pis_valor: number

  cofins_situacao_tributaria: string
  /** Sempre presentes e zerados quando cofins_situacao_tributaria=49 — confirmado por XML real. */
  cofins_base_calculo: number
  cofins_aliquota_porcentual: number
  cofins_valor: number

  /** Sem sub-campos de valor — grupo "não tributado" (CST 53) não tem vBC/pIPI/vIPI no XML nacional, confirmado. */
  ipi_situacao_tributaria: string
  ipi_codigo_enquadramento_legal: string

  /** IBS/CBS (reforma tributária, obrigatório desde 01/2026) — ver comentário do arquivo. */
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

  informacoes_adicionais_item?: string
}

export interface FocusNfePayload {
  natureza_operacao: string
  presenca_comprador: number
  /** 1=operação interna, 2=interestadual, 3=exterior (3 não suportado nesta fase). */
  local_destino: 1 | 2
  modalidade_frete: number
  /** indFinal — confirmado no XML real: sempre 1 (consumidor final) no nosso cenário de varejo direto. */
  consumidor_final: 0 | 1
  /** indIntermed — confirmado no XML real: sempre 0 (sem marketplace/intermediador) — loja própria. */
  indicador_intermediario: 0 | 1

  cnpj_emitente: string
  /**
   * Espelha company_fiscal_settings.crt — nunca hardcoded, é o único ponto
   * que muda na transição MEI→ME (ver relatório da fase, seção C).
   * `=4` (MEI) confirmado como valor aceito — ver nota de fechamento no
   * topo do arquivo.
   */
  regime_tributario_emitente: number

  nome_destinatario: string
  cpf_destinatario?: string
  cnpj_destinatario?: string
  telefone_destinatario?: string
  email_destinatario?: string
  logradouro_destinatario: string
  numero_destinatario: string
  complemento_destinatario?: string
  bairro_destinatario: string
  municipio_destinatario: string
  /**
   * Código IBGE do município do destinatário — resolvido por
   * `resolveMunicipioIbge` (cache + API pública do IBGE, nunca lista de
   * cidades hardcoded) e tratado como PREFERÊNCIA FORTE por este ERP:
   * `buildNfePayload` continua exigindo esse valor resolvido antes de
   * montar o payload (`FiscalBuildError` se ausente) — decisão mantida
   * deliberadamente nesta fase de fechamento, não enfraquecida.
   *
   * Nota documentada (não implementada como fallback): é plausível que a
   * própria Focus consiga resolver o código IBGE internamente a partir de
   * `municipio_destinatario`+`uf_destinatario` quando este campo não é
   * enviado — muitas integrações desse tipo fazem esse tipo de
   * derivação server-side. Isto NÃO foi confirmado na documentação
   * consultada, e este ERP não depende disso: continuamos resolvendo e
   * exigindo o código localmente como caminho primário e único suportado.
   * Se uma fase futura decidir relaxar essa exigência (ex.: permitir
   * emissão sem IBGE confiando na Focus), isso é uma mudança de política
   * deliberada — não deve ser inferida silenciosamente deste comentário.
   */
  codigo_municipio_destinatario?: string
  uf_destinatario: string
  cep_destinatario: string
  /** 1=contribuinte ICMS, 2=contribuinte isento, 9=não contribuinte (nosso cenário: pessoa física, sempre 9). */
  indicador_inscricao_estadual_destinatario: 1 | 2 | 9
  inscricao_estadual_destinatario?: string

  items: FocusNfeItemPayload[]
  /** Fase Fiscal 3A — ver FocusFormaPagamento. Obrigatório ter ao menos 1 entrada (buildNfePayload valida). */
  formas_pagamento: FocusFormaPagamento[]
}
