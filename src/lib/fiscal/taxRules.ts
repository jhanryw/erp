/**
 * Regras tributárias mínimas — Fase Fiscal 2A, revisadas na Fase Fiscal 2B
 * com evidência empírica real: 2 XMLs de NF-e modelo 55, autorizados pela
 * SEFAZ (cStat=100, protocolo real), emitidos pela própria empresa em
 * CRT=4, comportamento de produção. Onde este arquivo já acertava (CFOP,
 * CSOSN, IPI), os XMLs confirmam. Onde havia incerteza (PIS/COFINS,
 * IBS/CBS), os XMLs resolveram — ver comentários de cada função.
 *
 * Módulo PURO: nenhuma chamada de rede, nenhum acesso a banco, nenhuma
 * credencial. Recebe contexto já resolvido (CRT, UFs, etc.) e devolve
 * códigos fiscais. Testável isoladamente, determinístico.
 *
 * Escopo deliberadamente restrito ao que a empresa realmente vende hoje:
 * revenda de mercadoria de terceiros pra consumidor final. CRT 2 e 3 não
 * têm regra implementada — chamar essas funções com CRT 2/3 lança
 * `FiscalRuleNotImplementedError` em vez de arriscar um código fiscal
 * errado (nunca inventamos comportamento sem fonte).
 *
 * Fontes (ver relatório da Fase Fiscal 2A, seção C, pro detalhe completo):
 *   - CRT 4 (MEI): Nota Técnica 2024.001 (SEFAZ) tornou CRT=4 obrigatório
 *     e restringiu CSOSN a {102, 300, 400, 900} e, quando CSOSN=102, CFOP
 *     a {5102, 6102} — mesmo pra venda interestadual a consumidor final
 *     não contribuinte (onde a regra geral não-MEI usaria 6108). Rejeições
 *     SEFAZ 782 (CSOSN) e 337 (CFOP) documentam essa restrição
 *     especificamente pra emitente MEI. Confirmado via blog oficial Focus
 *     (nota-tecnica-2024-001-nfe-nfce-e-crt-4-regras-de-validacao) e
 *     múltiplas plataformas de emissão independentes (TreeUNFe, Omie,
 *     CIGAM, TecnoSpeed) descrevendo a mesma rejeição — tratado como
 *     confirmado, mas ainda listado como item a reconfirmar com a Focus
 *     antes da primeira emissão real (ver relatório, seção G).
 *   - CRT 1 (Simples Nacional, não-MEI): regra geral de CFOP pra venda de
 *     mercadoria de terceiros — 5102 (mesmo estado) / 6108 (interestadual,
 *     consumidor final não contribuinte) — prática fiscal brasileira
 *     padrão, sem a restrição específica de MEI.
 *   - CSOSN 102 ("Tributada pelo Simples Nacional sem permissão de
 *     crédito"): válido tanto pra CRT 1 quanto CRT 4 — é o código padrão
 *     pra revenda simples de mercadoria, sem ST/isenção/redução.
 *   - PIS/COFINS CST 49 ("Outras operações de saída"): prática contábil
 *     mais citada pra Simples Nacional/MEI (tributos recolhidos via DAS,
 *     sem destaque por operação) — NÃO é uma regra de validação SEFAZ
 *     documentada como CSOSN/CFOP são; é convenção contábil. Marcado como
 *     confirmação pendente com contador antes da primeira emissão real
 *     (ver relatório, seção G) — mas é o único caminho pra produzir um
 *     payload válido nesta fase (o campo é obrigatório na Focus).
 *   - IPI CST 53 ("Saída não tributada") + código de enquadramento legal
 *     "999" ("não afeta código específico"): prática padrão pra
 *     não-contribuinte de IPI (revendedor, não industrializador) —
 *     `ipi_codigo_enquadramento_legal=999` é confirmado como o valor pra
 *     "não aplicável" na doc de campos da Focus; o CST 53 é convenção
 *     contábil, mesmo status de confirmação pendente que PIS/COFINS.
 */

export type Crt = 1 | 2 | 3 | 4

export class FiscalRuleNotImplementedError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'FiscalRuleNotImplementedError'
  }
}

/** Exportado pra `validateFiscalReadiness` poder checar CRT suportado ANTES de montar/transmitir, sem duplicar esta lista (fonte única — nunca deixa as duas checagens divergirem). */
export const SUPPORTED_CRT: readonly Crt[] = [1, 4]

function assertSupportedCrt(crt: Crt, ruleName: string): void {
  if (!SUPPORTED_CRT.includes(crt)) {
    throw new FiscalRuleNotImplementedError(
      `${ruleName}: CRT=${crt} não tem regra implementada nesta fase (só CRT 1 — Simples Nacional — e CRT 4 — MEI — têm fonte confirmada). Não presuma um código fiscal pra este regime.`,
    )
  }
}

// ─── CFOP ───────────────────────────────────────────────────────────────────

export interface CfopContext {
  originUf: string
  destinationUf: string
  crt: Crt
}

/**
 * Venda de mercadoria adquirida de terceiros (nosso único cenário real
 * hoje — varejo de vestuário/lingerie, não fabricante). Não implementa
 * devolução, transferência, industrialização, ou venda a contribuinte —
 * cenários que não usamos ainda.
 */
export function resolveCfop({ originUf, destinationUf, crt }: CfopContext): string {
  assertSupportedCrt(crt, 'resolveCfop')

  const interstate = originUf.trim().toUpperCase() !== destinationUf.trim().toUpperCase()

  if (crt === 4) {
    // MEI — CFOP restrito a 5102/6102 (rejeição SEFAZ 337), mesmo p/
    // interestadual a consumidor final não contribuinte.
    return interstate ? '6102' : '5102'
  }

  // crt === 1 — Simples Nacional normal (regra geral, sem a restrição MEI)
  return interstate ? '6108' : '5102'
}

// ─── ICMS — CSOSN ───────────────────────────────────────────────────────────

/**
 * CSOSN pra revenda simples de mercadoria (sem ST, sem isenção, sem
 * redução de base) — único cenário tributário que implementamos. Válido
 * pra CRT 1 e CRT 4 (102 está na lista permitida pra MEI: 102/300/400/900).
 */
export function resolveIcmsCsosn(crt: Crt): string {
  assertSupportedCrt(crt, 'resolveIcmsCsosn')
  return '102'
}

// ─── PIS/COFINS ─────────────────────────────────────────────────────────────

export interface PisCofinsResult {
  cst: string
}

/**
 * CST 49 pra PIS e COFINS — CONFIRMADO empiricamente pelos XMLs reais
 * (Fase 2B): `<PISOutr><CST>49</CST>...` e `<COFINSOutr><CST>49</CST>...`
 * em toda nota, sem exceção. A base de cálculo/alíquota/valor SEMPRE
 * aparecem no XML, explicitamente zerados (`vBC=0.00`, `pPIS=0.00`,
 * `vPIS=0.00`) — nunca omitidos. `buildNfePayload` agora envia esses
 * sub-campos como 0 em vez de omiti-los (decisão revertida da Fase 2A).
 */
export function resolvePisCofinsCst(crt: Crt): PisCofinsResult {
  assertSupportedCrt(crt, 'resolvePisCofinsCst')
  return { cst: '49' }
}

// ─── IPI ────────────────────────────────────────────────────────────────────

export interface IpiResult {
  cst: string
  codigoEnquadramentoLegal: string
}

/**
 * Tratamento de IPI pra não-contribuinte de IPI (revendedor, não
 * industrializador) — não varia por CRT nas fontes consultadas.
 * `codigoEnquadramentoLegal='999'` é confirmado (doc oficial de campos da
 * Focus) como o valor pra "não aplicável". CST 53 é convenção contábil,
 * mesmo status de confirmação pendente que PIS/COFINS.
 */
export function resolveIpiTreatment(): IpiResult {
  return { cst: '53', codigoEnquadramentoLegal: '999' }
}

// ─── IBS/CBS (Reforma Tributária — EC 132/2023, LC 214/2025) ───────────────

export interface IbsCbsResult {
  situacaoTributaria: string
  classificacaoTributaria: string
  /** Base de cálculo — 0.00 no ano-teste em ambos os XMLs reais, mesmo com item de valor não nulo. Reproduzido exatamente como observado, não computado a partir do valor do item. */
  baseCalculo: number
  aliquotaIbsUf: number
  aliquotaIbsMunicipio: number
  aliquotaCbs: number
  /** Valores calculados — sempre 0 no ano-teste (dispensa de recolhimento), mas SEMPRE enviados explicitamente (nunca omitidos), mesmo padrão confirmado pra PIS/COFINS. */
  valorIbsUf: number
  valorIbsMunicipio: number
  /** IBS combinado do item (UF+Município) — campo Focus `ibs_valor_total` mesmo em escopo de item (nome confuso, confirmado por leitura direta do HTML de campos.focusnfe.com.br, não é o total do documento). */
  valorIbsItem: number
  valorCbs: number
}

/**
 * Ano-teste 2026: confirmado por anúncio oficial conjunto do Comitê Gestor
 * do IBS + Receita Federal (cgibs.gov.br) — todo documento fiscal deve
 * calcular/declarar IBS e CBS com alíquota real desde 01/01/2026, mas o
 * CONTRIBUINTE FICA DISPENSADO DE RECOLHER (valor final é sempre zero),
 * condicionado a cumprir a obrigação acessória (ou seja, declarar
 * corretamente, não pagar). Confirmado pelos 2 XMLs reais: alíquotas não
 * nulas (pIBSUF=0.10%, pCBS=0.90%) resultando em valores sempre 0.00.
 *
 * `situacaoTributaria='000'` + `classificacaoTributaria='000001'`
 * ("tributação integral", sem benefício/redução) — confirmado nos XMLs
 * (`<IBSCBS><CST>000</CST><cClassTrib>000001</cClassTrib>`) e na tabela
 * oficial de cClassTrib (Portal Nacional NF-e / SVRS).
 *
 * IMPORTANTE: as alíquotas do ano-teste são fixas por lei pra 2026 — não
 * variam por CRT, produto ou operação nesta fase (o mecanismo de
 * dispensa de recolhimento é o mesmo pra todo mundo). Isto muda em 2027+
 * conforme o cronograma de transição da reforma — nunca usar esta função
 * sem revisar a data/ano quando chegar a hora.
 *
 * Alíquota do IBS-Município ficou 0.00% nos dois XMLs reais (só a parcela
 * UF tem alíquota não nula no ano-teste) — reproduzido aqui exatamente
 * como observado, não uma suposição de simetria com a alíquota de UF.
 *
 * Fase Fiscal 2B — nomes de campo Focus reconfirmados por leitura DIRETA
 * do HTML bruto de campos.focusnfe.com.br/nfe/NotaFiscalXML.html via curl
 * (não por fetch resumido por IA, que tinha risco de paráfrase — ver
 * relatório da fase, seção A). Campos de item confirmados, todos
 * `"required":false` exceto os dois primeiros:
 *   ibs_cbs_situacao_tributaria (required=true, tag CST)
 *   ibs_cbs_classificacao_tributaria (required=true, tag cClassTrib)
 *   ibs_cbs_base_calculo (tag vBC) · ibs_uf_aliquota (tag pIBSUF) ·
 *   ibs_uf_valor (tag vIBSUF) · ibs_mun_aliquota (tag pIBSMun) ·
 *   ibs_mun_valor (tag vIBSMun) · ibs_valor_total (tag vIBS — nome
 *   reaproveitado do total do documento, mas confirmado em escopo de
 *   item pela posição no HTML, antes de `informacoes_adicionais_item`) ·
 *   cbs_aliquota (tag pCBS) · cbs_valor (tag vCBS).
 * Valores calculados (`ibs_uf_valor`/`ibs_mun_valor`/`ibs_valor_total`/
 * `cbs_valor`) SEMPRE enviados explicitamente como 0 nesta fase — mesmo
 * padrão confirmado pra PIS/COFINS (nunca omitir um campo que o XML real
 * mostra presente, mesmo zerado).
 */
export function resolveIbsCbsTestYear2026(): IbsCbsResult {
  return {
    situacaoTributaria: '000',
    classificacaoTributaria: '000001',
    baseCalculo: 0,
    aliquotaIbsUf: 0.1,
    aliquotaIbsMunicipio: 0,
    aliquotaCbs: 0.9,
    valorIbsUf: 0,
    valorIbsMunicipio: 0,
    valorIbsItem: 0,
    valorCbs: 0,
  }
}
