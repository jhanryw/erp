/**
 * Tipos do cliente Focus NFe (Fase Fiscal 1 — fundação).
 *
 * Escopo desta fase: só client/autenticação/consulta segura. NÃO inclui o
 * payload de emissão (`POST /v2/nfe`) — a Focus não distingue numeração
 * manual/automática pra NF-e (confirmado: `numero`/`serie` não existem no
 * corpo da requisição), e o payload completo depende de um motor de regras
 * fiscais que ainda não existe neste ERP. Emissão fica pra uma fase
 * seguinte, depois que o payload puder ser montado com dado real.
 */

export type FocusEnvironment = 'homologacao' | 'producao'

/** Base URLs oficiais — nunca hardcoded fora deste arquivo. */
export const FOCUS_BASE_URLS: Record<FocusEnvironment, string> = {
  homologacao: 'https://homologacao.focusnfe.com.br',
  producao: 'https://api.focusnfe.com.br',
}

export interface FocusRequestOptions {
  token: string
  environment: FocusEnvironment
  /** ms — default aplicado em focusRequest se omitido. */
  timeoutMs?: number
}

/**
 * Erro síncrono (a chamada HTTP em si falhou, SEFAZ nunca viu a tentativa)
 * — 400/422 com campo `codigo`, confirmado na doc oficial. Valores
 * conhecidos: requisicao_invalida, erro_validacao_schema, permissao_negada,
 * pending_operation, already_processed. Mantido como `string` (não union
 * fechada) porque a doc não garante que essa lista seja exaustiva.
 */
export interface FocusSyncErrorBody {
  codigo: string
  mensagem: string
}

export class FocusApiError extends Error {
  readonly httpStatus: number
  readonly codigo: string | null
  readonly mensagem: string | null

  constructor(httpStatus: number, body: unknown) {
    const parsed = FocusApiError.parseBody(body)
    super(parsed.mensagem ?? `Focus NFe retornou HTTP ${httpStatus} sem corpo reconhecível.`)
    this.name = 'FocusApiError'
    this.httpStatus = httpStatus
    this.codigo = parsed.codigo
    this.mensagem = parsed.mensagem
  }

  private static parseBody(body: unknown): { codigo: string | null; mensagem: string | null } {
    if (body && typeof body === 'object') {
      const b = body as Record<string, unknown>
      return {
        codigo: typeof b.codigo === 'string' ? b.codigo : null,
        mensagem: typeof b.mensagem === 'string' ? b.mensagem : null,
      }
    }
    return { codigo: null, mensagem: null }
  }
}

/**
 * Resposta de `GET /v2/empresas` — campos reduzidos ao que realmente
 * consumimos (a resposta real tem ~150 campos, incluindo contadores de
 * numeração por documento/ambiente — não modelados aqui, fora de escopo).
 * `id` é o identificador Focus (não confundir com nenhum id do ERP) —
 * necessário pra `PUT /v2/empresas/{id}` no fluxo de update.
 */
export interface FocusEmpresa {
  id: number
  cnpj: string
  cpf?: string
  nome: string
  nome_fantasia?: string
  habilita_nfe?: boolean
  regime_tributario?: number
  certificado_valido_ate?: string | null
  certificado_valido_de?: string | null
}

/**
 * Payload de criação/atualização de empresa (`POST /v2/empresas` /
 * `PUT /v2/empresas/{id}`) — campos confirmados na doc oficial
 * (doc.focusnfe.com.br/reference/criar_empresa, /atualizar_empresa).
 *
 * `regime_tributario`: 1=Simples Nacional, 2=Simples Nacional excesso de
 * sublimite, 3=Regime Normal, 4=Simples Nacional-MEI — mesmos valores do
 * CRT em company_fiscal_settings.crt (nunca reinterpretados, só repassados).
 *
 * Certificado: `arquivo_certificado_base64` (PFX/P12 em base64) +
 * `senha_certificado` (obrigatório só quando o arquivo é enviado) — fluxo
 * oficial confirmado (doc + blog Focus "Como vincular o certificado
 * digital modelo A1..."). NUNCA persistido no ERP — só passa por memória
 * nesta requisição, nunca logado.
 */
export interface FocusEmpresaInput {
  nome: string
  nome_fantasia?: string
  cnpj?: string
  cpf?: string
  inscricao_estadual?: string
  inscricao_municipal?: string
  regime_tributario: number
  logradouro?: string
  numero?: string
  complemento?: string
  bairro?: string
  cep?: string
  municipio?: string
  uf?: string
  telefone?: string
  email?: string
  habilita_nfe?: boolean
  arquivo_certificado_base64?: string
  senha_certificado?: string
  /**
   * CSC de NFC-e (Motor Fiscal Configurável — Fase Certificado/CSC) —
   * campos confirmados na doc oficial (doc.focusnfe.com.br/reference/
   * empresas). A empresa guarda os DOIS pares (homologação e produção)
   * simultaneamente — o par usado em cada emissão real é decidido pela
   * Focus a partir do ambiente da chamada de emissão (`/v2/nfce` no host
   * de homologação ou produção), nunca por um campo aqui. `habilita_nfce`
   * precisa ser `true` pra qualquer um dos dois pares ter efeito.
   */
  habilita_nfce?: boolean
  csc_nfce_homologacao?: string
  id_token_nfce_homologacao?: string
  csc_nfce_producao?: string
  id_token_nfce_producao?: string
}

/**
 * Bloco `protocolo_nota_fiscal` — presente só quando `status='autorizado'`.
 * Confirmado por exemplo real na doc oficial (`doc.focusnfe.com.br/
 * reference/consultar_nfe`, lido via HTML bruto/curl, Fase Fiscal 2B):
 * `numero_protocolo` é o campo que corresponde ao `nProt` do XML — NUNCA
 * um campo `protocolo` plano no nível raiz da resposta, como uma leitura
 * apressada da doc poderia sugerir (`protocolo` sozinho é só o nome de
 * outros campos relacionados — `protocolo_cancelamento`,
 * `protocolo_carta_correcao` —, não este).
 */
export interface FocusNfeProtocoloNotaFiscal {
  versao: string
  ambiente: string
  chave_nfe: string
  data_recebimento: string
  numero_protocolo: string
  status: string
  motivo: string
}

/**
 * Resposta de emissão (`POST /v2/nfe`, quando processada — não o erro
 * síncrono 400/422, que vira `FocusApiError`) e de consulta
 * (`GET /v2/nfe/{ref}`) — MESMO formato nas duas, confirmado por exemplo
 * real na doc oficial (Fase Fiscal 2B, leitura de HTML bruto via curl,
 * não resumo de IA). Exemplo real observado (documento autorizado):
 * `{cnpj_emitente, ref, status:"autorizado", status_sefaz:"100",
 * mensagem_sefaz:"Autorizado...", chave_nfe, numero, serie,
 * caminho_xml_nota_fiscal, caminho_danfe, caminho_danfe_etiqueta,
 * protocolo_nota_fiscal:{...}}`. Exemplo "processando_autorizacao":
 * `{cnpj_emitente, ref, status:"processando_autorizacao"}` — só isso,
 * sem nenhum dos campos de resultado ainda.
 */
export interface FocusNfeConsultaResponse {
  cnpj_emitente?: string
  ref?: string
  status: 'autorizado' | 'processando_autorizacao' | 'erro_autorizacao' | 'cancelado' | 'erro_cancelamento'
  /** Tipagem observada inconsistente entre exemplos da própria doc (string em um, number em outro) — normalizar pra string ao persistir. */
  status_sefaz?: string | number
  mensagem_sefaz?: string
  numero?: string
  serie?: string
  chave_nfe?: string
  caminho_xml_nota_fiscal?: string
  caminho_danfe?: string
  caminho_danfe_etiqueta?: string
  protocolo_nota_fiscal?: FocusNfeProtocoloNotaFiscal
}

/**
 * Resposta de emissão (`POST /v2/nfce`, síncrona — o resultado já vem
 * nesta mesma chamada, nunca precisa de polling) e de consulta
 * (`GET /v2/nfce/{referencia}`) — Fase Fiscal 4E.
 *
 * `status`: união dos 3 schemas reais de resposta de consulta
 * (`NFCeConsultaResponse`/`CanceladaResponse`/`ErroAutorizacaoResponse`) —
 * inclui `'denegado'`, um status que NÃO existe no enum confirmado de NF-e
 * (`FocusNfeConsultaResponse`) — SEFAZ recusando autorização por motivo
 * cadastral do emitente (ex.: irregularidade), distinto de
 * `erro_autorizacao` (rejeição por dado da própria nota). Nunca aparece
 * `'processando_autorizacao'` na resposta de EMISSÃO (síncrona, só
 * `autorizado`/`erro_autorizacao` imediatamente) — mantido no union type
 * mesmo assim por segurança defensiva (mesmo padrão de NF-e: nunca assumir
 * que um valor documentado como "não deveria aparecer aqui" realmente
 * nunca aparece).
 *
 * ─── `protocolo` (CORRIGIDO — venda 703, homologação, 2026-08-28) ────────
 *
 * O campo REAL do protocolo de autorização (`nProt` do XML) na resposta de
 * NFC-e é `protocolo` PLANO no nível raiz — confirmado por
 * `provider_payload` capturado de uma emissão real (venda 703):
 * `{..., "chave_nfe": "NFe2426...", "protocolo": "324260000079215",
 * "qrcode_url": "...", ...}`. NUNCA `numero_protocolo` — esse nome foi
 * assumido por analogia ao campo de NF-e (que usa
 * `protocolo_nota_fiscal.numero_protocolo`, aninhado, CONFIRMADO à parte —
 * ver `FocusNfeProtocoloNotaFiscal`) sem verificação real, e nenhuma
 * resposta real de NFC-e jamais trouxe essa chave (é por isso que a venda
 * 703 ficou com `authorization_protocol` NULL apesar de autorizada — ver
 * auditoria completa em `submitNfceHomologacao.ts`). `numero_protocolo`
 * continua tipado abaixo só como FALLBACK de compatibilidade legada (nunca
 * confirmado em nenhuma resposta real da Focus) — resolução sempre
 * prioriza `protocolo`, ver `resolveNfceAuthorizationProtocol` em
 * `submitNfceHomologacao.ts`.
 */
export interface FocusNfceConsultaResponse {
  cnpj_emitente?: string
  ref?: string
  status: 'autorizado' | 'processando_autorizacao' | 'erro_autorizacao' | 'denegado' | 'cancelado' | 'erro_cancelamento'
  status_sefaz?: string | number
  mensagem_sefaz?: string
  numero?: string
  serie?: string
  chave_nfe?: string
  caminho_xml_nota_fiscal?: string
  /** Formato `.html` (DANFCe) — diferente do DANFE de NF-e. */
  caminho_danfe?: string
  /** URL do QR Code pro consumidor consultar a nota — sem equivalente em NF-e. */
  qrcode_url?: string
  url_consulta_nf?: string
  caminho_xml_cancelamento?: string
  /** Campo REAL do protocolo de autorização (`nProt`) — confirmado por payload real (venda 703). Ver comentário completo acima da interface. */
  protocolo?: string | null
  /** LEGADO/FALLBACK — nunca confirmado em nenhuma resposta real da Focus. Mantido só por compatibilidade com integrações/fixtures antigas; `protocolo` é sempre preferido. Ver comentário completo acima da interface. */
  numero_protocolo?: string
  /** Presente só em erro_autorizacao — lista de erros de validação/rejeição, formato não detalhado no OpenAPI público. */
  erros?: unknown[]
}
