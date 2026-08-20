/**
 * Testes de concorrência/idempotência — Fase Fiscal 3B.
 *
 * IMPORTANTE — o que estes testes PROVAM e o que NÃO provam: rodam contra
 * `testFakeAdminClient.ts`, uma simulação em memória de thread única
 * (Node/JS). A "atomicidade" do claim fake vem de uma propriedade real do
 * JS (nenhum `await` dentro da seção crítica das funções fake — ver
 * comentário no topo de `testFakeAdminClient.ts`), o que é suficiente pra
 * provar que o SERVICE reage corretamente a cada decisão possível. Isso
 * NÃO prova que o `FOR UPDATE`/MVCC do Postgres real serializa
 * corretamente sob concorrência de processos/conexões de verdade — essa
 * prova está em `supabase/tests/rpc_claim_fiscal_emission.concurrency.md`
 * (procedimento manual com 2 terminais `psql`, mesmo padrão já usado pra
 * `rpc_claim_outbox_events`).
 */

import { describe, it, expect, vi, afterEach } from 'vitest'
import { submitNfeHomologacao, buildProviderRef } from './submitNfeHomologacao'
import * as resolveModule from './resolveFocusIntegration'
import * as loadModule from './loadSaleFiscalContext'
import * as validateModule from './validateFiscalReadiness'
import * as httpClient from '@/lib/integrations/focus/httpClient'
import { FocusApiError } from '@/lib/integrations/focus/types'
import { createAdminClient } from '@/lib/supabase/admin'
import { createFakeAdmin, mockCreateAdminClient } from './testFakeAdminClient'
import { baseFiscalContext } from './testFixtures'

vi.mock('@/lib/supabase/admin', () => ({ createAdminClient: vi.fn() }))

const COMPANY_ID = 1
const SALE_ID = 909

function setupFake() {
  const fake = createFakeAdmin({
    company_fiscal_settings: [{ id: 1, company_id: COMPANY_ID, nfe_environment: 'homologacao', nfe_enabled: true }],
  })
  ;(createAdminClient as unknown as ReturnType<typeof vi.fn>).mockImplementation(mockCreateAdminClient(fake))
  return fake
}

function mockHappyPathDependencies() {
  vi.spyOn(resolveModule, 'resolveFocusIntegration').mockResolvedValue({
    ok: true,
    data: { available: true, integration: { integrationId: 1, companyId: COMPANY_ID, token: 'tok', environment: 'homologacao' } },
  })
  vi.spyOn(loadModule, 'loadSaleFiscalContext').mockResolvedValue(baseFiscalContext({ saleId: SALE_ID, companyId: COMPANY_ID }))
  vi.spyOn(validateModule, 'validateFiscalReadiness').mockReturnValue([])
}

describe('Claim concorrente — a primitiva RPC fake, isolada', () => {
  afterEach(() => { vi.restoreAllMocks() })

  it('N chamadas concorrentes de rpc_claim_fiscal_emission pra mesma venda → exatamente 1 "claimed", as demais "busy"', async () => {
    const fake = setupFake()
    const ref = buildProviderRef(COMPANY_ID, SALE_ID)

    const N = 10
    const results = await Promise.all(
      Array.from({ length: N }, () =>
        (fake.client as any).rpc('rpc_claim_fiscal_emission', {
          p_company_id: COMPANY_ID,
          p_sale_id: SALE_ID,
          p_provider_ref: ref,
          p_environment: 'homologacao',
          p_lease_seconds: 60,
        }),
      ),
    )

    const decisions = results.map((r: any) => r.data[0].decision)
    expect(decisions.filter((d: string) => d === 'claimed')).toHaveLength(1)
    expect(decisions.filter((d: string) => d === 'busy')).toHaveLength(N - 1)

    // Nunca duas linhas fiscal_documents criadas pra mesma venda.
    const rows = fake.tables.fiscal_documents.filter((r) => r.sale_id === SALE_ID)
    expect(rows).toHaveLength(1)
  })
})

describe('Service concorrente — submitNfeHomologacao x2', () => {
  afterEach(() => { vi.restoreAllMocks() })

  it('Promise.all([submit, submit]) pra mesma venda → issueFocusNfe chamado EXATAMENTE 1 vez', async () => {
    setupFake()
    mockHappyPathDependencies()
    const issueSpy = vi.spyOn(httpClient, 'issueFocusNfe').mockResolvedValue({ status: 'processando_autorizacao' })

    const [r1, r2] = await Promise.all([
      submitNfeHomologacao(SALE_ID, COMPANY_ID),
      submitNfeHomologacao(SALE_ID, COMPANY_ID),
    ])

    expect(issueSpy).toHaveBeenCalledTimes(1)
    expect(r1.ok).toBe(true)
    expect(r2.ok).toBe(true)
  })
})

describe('Stress test — 100 submits concorrentes pra mesma venda', () => {
  afterEach(() => { vi.restoreAllMocks() })

  it('100 chamadas concorrentes → no máximo 1 POST /v2/nfe', async () => {
    setupFake()
    mockHappyPathDependencies()
    const issueSpy = vi.spyOn(httpClient, 'issueFocusNfe').mockResolvedValue({ status: 'processando_autorizacao' })

    const results = await Promise.all(Array.from({ length: 100 }, () => submitNfeHomologacao(SALE_ID, COMPANY_ID)))

    expect(issueSpy.mock.calls.length).toBeLessThanOrEqual(1)
    expect(results.every((r) => r.ok)).toBe(true)
  })
})

describe('Lease expirada — NUNCA autoriza retransmissão direta (seção 7 do pedido; risco residual #2 fechado com submission_started_at)', () => {
  afterEach(() => { vi.restoreAllMocks() })

  it('status=pending com lease expirada E submission_started_at setado (transmissão foi despachada) → reconciliation_required (consulta), NUNCA busy, NUNCA POST direto', async () => {
    const fake = setupFake()
    mockHappyPathDependencies()
    fake.seedFiscalDocument({
      company_id: COMPANY_ID, sale_id: SALE_ID, document_type: 'nfe', provider: 'focus_nfe',
      environment: 'homologacao', provider_ref: buildProviderRef(COMPANY_ID, SALE_ID), status: 'pending',
      submission_claim_token: 'token-antigo', submission_lease_until: new Date(Date.now() - 1000).toISOString(), // já expirou
      submission_started_at: new Date(Date.now() - 2000).toISOString(), // uma transmissão real foi despachada sob o claim anterior
    })

    const issueSpy = vi.spyOn(httpClient, 'issueFocusNfe')
    const consultSpy = vi.spyOn(httpClient, 'consultFocusNfe').mockResolvedValue({ status: 'processando_autorizacao' })

    const result = await submitNfeHomologacao(SALE_ID, COMPANY_ID)

    expect(issueSpy).not.toHaveBeenCalled()
    expect(consultSpy).toHaveBeenCalledOnce()
    expect(result.ok).toBe(true)
  })

  it('status=pending com lease AINDA ativa → busy, nunca consulta nem reemite', async () => {
    const fake = setupFake()
    mockHappyPathDependencies()
    fake.seedFiscalDocument({
      company_id: COMPANY_ID, sale_id: SALE_ID, document_type: 'nfe', provider: 'focus_nfe',
      environment: 'homologacao', provider_ref: buildProviderRef(COMPANY_ID, SALE_ID), status: 'pending',
      submission_claim_token: 'token-ativo', submission_lease_until: new Date(Date.now() + 60_000).toISOString(),
    })

    const issueSpy = vi.spyOn(httpClient, 'issueFocusNfe')
    const consultSpy = vi.spyOn(httpClient, 'consultFocusNfe')

    const result = await submitNfeHomologacao(SALE_ID, COMPANY_ID)

    expect(issueSpy).not.toHaveBeenCalled()
    expect(consultSpy).not.toHaveBeenCalled()
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.data.status).toBe('pending')
  })
})

describe('Recuperação de crash — cenário A: processo morre ANTES do POST (submission_started_at nunca chegou a ser setado)', () => {
  afterEach(() => { vi.restoreAllMocks() })

  it('claim expira sem nenhuma transmissão ter sido despachada (sem submission_started_at) → NENHUMA evidência de transmissão anterior → a PRÓPRIA PRIMEIRA chamada seguinte já transmite de verdade, sem precisar reconciliar antes', async () => {
    const fake = setupFake()
    mockHappyPathDependencies()
    fake.seedFiscalDocument({
      company_id: COMPANY_ID, sale_id: SALE_ID, document_type: 'nfe', provider: 'focus_nfe',
      environment: 'homologacao', provider_ref: buildProviderRef(COMPANY_ID, SALE_ID), status: 'pending',
      submission_claim_token: 'token-morto', submission_lease_until: new Date(Date.now() - 1000).toISOString(),
      // submission_started_at NÃO setado — o processo morreu durante
      // validação/montagem do payload, ANTES de rpc_begin_fiscal_transmission
      // rodar. Sob o fechamento do risco residual #2, isto é precisamente o
      // caso 1 do pedido ("não houver evidência de transmissão anterior") —
      // reclamar direto é seguro, consultar a Focus antes seria um
      // round-trip desnecessário (ela nunca viu essa ref).
    })

    const consultSpy = vi.spyOn(httpClient, 'consultFocusNfe')
    const issueSpy = vi.spyOn(httpClient, 'issueFocusNfe').mockResolvedValue({ status: 'processando_autorizacao' })

    const result = await submitNfeHomologacao(SALE_ID, COMPANY_ID)

    expect(consultSpy).not.toHaveBeenCalled() // nenhuma reconciliação necessária
    expect(issueSpy).toHaveBeenCalledOnce()
    expect(result.ok).toBe(true)
  })
})

describe('Recuperação de crash — cenário B: processo morre DURANTE o POST (estado desconhecido)', () => {
  afterEach(() => { vi.restoreAllMocks() })

  it('lease expira → consulta → Focus ainda processando de verdade → fica pending, NENHUM POST imediato', async () => {
    const fake = setupFake()
    mockHappyPathDependencies()
    fake.seedFiscalDocument({
      company_id: COMPANY_ID, sale_id: SALE_ID, document_type: 'nfe', provider: 'focus_nfe',
      environment: 'homologacao', provider_ref: buildProviderRef(COMPANY_ID, SALE_ID), status: 'pending',
      submission_claim_token: 'token-morto-durante-post', submission_lease_until: new Date(Date.now() - 1000).toISOString(),
      submission_started_at: new Date(Date.now() - 2000).toISOString(), // POST foi de fato despachado antes do crash
    })

    const issueSpy = vi.spyOn(httpClient, 'issueFocusNfe')
    const consultSpy = vi.spyOn(httpClient, 'consultFocusNfe').mockResolvedValue({ status: 'processando_autorizacao' })

    const result = await submitNfeHomologacao(SALE_ID, COMPANY_ID)

    expect(consultSpy).toHaveBeenCalledOnce()
    expect(issueSpy).not.toHaveBeenCalled() // NUNCA um POST imediato
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.data.status).toBe('pending')
  })
})

describe('Recuperação de crash — cenário C: Focus respondeu (rejeição), processo morre antes de persistir', () => {
  afterEach(() => { vi.restoreAllMocks() })

  it('nova execução consulta e recupera o estado real (erro_autorizacao, com status_sefaz/mensagem_sefaz reais), persiste localmente', async () => {
    const fake = setupFake()
    mockHappyPathDependencies()
    fake.seedFiscalDocument({
      company_id: COMPANY_ID, sale_id: SALE_ID, document_type: 'nfe', provider: 'focus_nfe',
      environment: 'homologacao', provider_ref: buildProviderRef(COMPANY_ID, SALE_ID), status: 'pending',
      submission_claim_token: 'token-morto-pos-resposta', submission_lease_until: new Date(Date.now() - 1000).toISOString(),
      submission_started_at: new Date(Date.now() - 2000).toISOString(), // POST foi de fato despachado antes do crash
    })

    vi.spyOn(httpClient, 'consultFocusNfe').mockResolvedValue({
      status: 'erro_autorizacao',
      status_sefaz: '598',
      mensagem_sefaz: 'Rejeição: Total da NF difere do somatório dos itens',
    })

    const result = await submitNfeHomologacao(SALE_ID, COMPANY_ID)
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.data.status).toBe('authorization_failed')
      expect(result.data.statusSefaz).toBe('598')
    }

    const persisted = fake.tables.fiscal_documents.find((r) => r.sale_id === SALE_ID)
    expect(persisted?.status).toBe('authorization_failed')
  })
})

describe('Recuperação de crash — cenário D: Focus autorizou, ERP não persistiu', () => {
  afterEach(() => { vi.restoreAllMocks() })

  it('reconciliação recupera status=autorizado + chave/número/série/protocolo/XML/DANFE e persiste localmente', async () => {
    const fake = setupFake()
    mockHappyPathDependencies()
    fake.seedFiscalDocument({
      company_id: COMPANY_ID, sale_id: SALE_ID, document_type: 'nfe', provider: 'focus_nfe',
      environment: 'homologacao', provider_ref: buildProviderRef(COMPANY_ID, SALE_ID), status: 'pending',
      submission_claim_token: 'token-morto', submission_lease_until: new Date(Date.now() - 1000).toISOString(),
      submission_started_at: new Date(Date.now() - 2000).toISOString(), // POST foi de fato despachado antes do crash
    })

    vi.spyOn(httpClient, 'consultFocusNfe').mockResolvedValue({
      status: 'autorizado',
      status_sefaz: '100',
      mensagem_sefaz: 'Autorizado o uso da NF-e',
      numero: '10',
      serie: '1',
      chave_nfe: '24260861523225000117550010000000101006759099',
      caminho_xml_nota_fiscal: '/arquivos/xml.xml',
      caminho_danfe: '/arquivos/danfe.pdf',
      protocolo_nota_fiscal: { versao: '4.00', ambiente: '1', chave_nfe: '...', data_recebimento: '...', numero_protocolo: '224260099999999', status: '100', motivo: 'Autorizado o uso da NF-e' },
    })

    const result = await submitNfeHomologacao(SALE_ID, COMPANY_ID)
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.data.status).toBe('authorized')
      expect(result.data.accessKey).toBe('24260861523225000117550010000000101006759099')
      expect(result.data.number).toBe('10')
      expect(result.data.authorizationProtocol).toBe('224260099999999')
      expect(result.data.xmlPath).toBe('/arquivos/xml.xml')
      expect(result.data.danfePath).toBe('/arquivos/danfe.pdf')
    }

    const persisted = fake.tables.fiscal_documents.find((r) => r.sale_id === SALE_ID)
    expect(persisted?.status).toBe('authorized')
    expect(persisted?.access_key).toBe('24260861523225000117550010000000101006759099')
  })
})

describe('Fechamento do risco residual #2 — submission_started_at protege POST lento além da lease', () => {
  afterEach(() => { vi.restoreAllMocks() })

  it('(a)+(b)+(c) POST demorando mais que a lease (60s): lease expira ENQUANTO o POST original ainda está em voo → uma segunda execução concorrente NUNCA chama issueFocusNfe de novo, só reconcilia', async () => {
    const fake = setupFake()
    mockHappyPathDependencies()

    let resolveIssue: (v: Awaited<ReturnType<typeof httpClient.issueFocusNfe>>) => void = () => {}
    const issuePromise = new Promise<Awaited<ReturnType<typeof httpClient.issueFocusNfe>>>((resolve) => { resolveIssue = resolve })

    const issueSpy = vi.spyOn(httpClient, 'issueFocusNfe').mockImplementation(async () => {
      // Neste ponto rpc_begin_fiscal_transmission já rodou (submission_started_at
      // setado) — simula os 60s da lease se esgotarem enquanto a Focus ainda
      // não respondeu (POST genuinamente mais lento que a lease).
      const row = fake.tables.fiscal_documents.find((r) => r.sale_id === SALE_ID)
      expect(row.submission_started_at).toBeTruthy() // pré-condição do teste
      row.submission_lease_until = new Date(Date.now() - 1000).toISOString()
      return issuePromise
    })
    const consultSpy = vi.spyOn(httpClient, 'consultFocusNfe').mockResolvedValue({ status: 'processando_autorizacao' })

    const firstCallPromise = submitNfeHomologacao(SALE_ID, COMPANY_ID)
    await new Promise((r) => setTimeout(r, 0)) // deixa a 1ª chamada chegar até dentro do mock de issueFocusNfe

    // 2ª execução concorrente, enquanto a 1ª AINDA não recebeu resposta da Focus.
    const second = await submitNfeHomologacao(SALE_ID, COMPANY_ID)

    expect(issueSpy).toHaveBeenCalledTimes(1) // NUNCA um segundo POST, mesmo com lease expirada
    expect(consultSpy).toHaveBeenCalledOnce() // a 2ª execução reconcilia, não reclama nem re-transmite
    expect(second.ok).toBe(true)
    if (second.ok) expect(second.data.status).toBe('pending')

    resolveIssue({ status: 'processando_autorizacao' })
    const first = await firstCallPromise
    expect(first.ok).toBe(true)
  })

  it('(d) crash logo APÓS marcar submission_started (antes do POST responder): reconciliation_required, ZERO novo POST', async () => {
    const fake = setupFake()
    mockHappyPathDependencies()
    fake.seedFiscalDocument({
      company_id: COMPANY_ID, sale_id: SALE_ID, document_type: 'nfe', provider: 'focus_nfe',
      environment: 'homologacao', provider_ref: buildProviderRef(COMPANY_ID, SALE_ID), status: 'pending',
      submission_claim_token: 'token-crash-pos-begin',
      submission_lease_until: new Date(Date.now() - 1000).toISOString(), // expirada
      submission_started_at: new Date(Date.now() - 2000).toISOString(), // marcado, mas o resultado do POST nunca chegou a ser gravado
    })

    const issueSpy = vi.spyOn(httpClient, 'issueFocusNfe')
    const consultSpy = vi.spyOn(httpClient, 'consultFocusNfe').mockResolvedValue({ status: 'processando_autorizacao' })

    const result = await submitNfeHomologacao(SALE_ID, COMPANY_ID)

    expect(issueSpy).not.toHaveBeenCalled()
    expect(consultSpy).toHaveBeenCalledOnce()
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.data.status).toBe('pending')
  })

  it('(e) reconciliação após esse crash: 404 confirma ausência inequívoca → retentável → PRÓXIMA chamada transmite com a MESMA provider_ref', async () => {
    const fake = setupFake()
    mockHappyPathDependencies()
    const ref = buildProviderRef(COMPANY_ID, SALE_ID)
    fake.seedFiscalDocument({
      company_id: COMPANY_ID, sale_id: SALE_ID, document_type: 'nfe', provider: 'focus_nfe',
      environment: 'homologacao', provider_ref: ref, status: 'pending',
      submission_claim_token: 'token-crash-a-reconciliar',
      submission_lease_until: new Date(Date.now() - 1000).toISOString(),
      submission_started_at: new Date(Date.now() - 2000).toISOString(),
    })

    vi.spyOn(httpClient, 'consultFocusNfe').mockRejectedValue(
      new FocusApiError(404, { codigo: 'nao_encontrado', mensagem: 'Nota fiscal não encontrada' }),
    )

    const first = await submitNfeHomologacao(SALE_ID, COMPANY_ID)
    expect(first.ok).toBe(true)
    if (first.ok) expect(first.data.status).toBe('submission_error')

    const issueSpy = vi.spyOn(httpClient, 'issueFocusNfe').mockResolvedValue({ status: 'processando_autorizacao' })
    const second = await submitNfeHomologacao(SALE_ID, COMPANY_ID)

    expect(issueSpy).toHaveBeenCalledOnce()
    expect(issueSpy.mock.calls[0][0]).toBe(ref) // MESMA provider_ref determinística, nunca uma nova
    expect(second.ok).toBe(true)

    // O claim concedido pra essa 2ª chamada reseta submission_started_at —
    // o novo ciclo de transmissão começa "limpo" (rpc_begin_fiscal_transmission
    // marca de novo antes deste próprio POST, comprovado pelo issueSpy acima).
    const row = fake.tables.fiscal_documents.find((r) => r.sale_id === SALE_ID)
    expect(row.provider_ref).toBe(ref)
  })
})

describe('rpc_begin_fiscal_transmission — race condition real fechada (lease vencida não bastava pra recusar begin)', () => {
  afterEach(() => { vi.restoreAllMocks() })

  async function claim(fake: ReturnType<typeof createFakeAdmin>, ref: string) {
    const res = await (fake.client as any).rpc('rpc_claim_fiscal_emission', {
      p_company_id: COMPANY_ID, p_sale_id: SALE_ID, p_provider_ref: ref, p_environment: 'homologacao', p_lease_seconds: 60,
    })
    return res.data[0]
  }

  async function begin(fake: ReturnType<typeof createFakeAdmin>, fiscalDocumentId: number, claimToken: string) {
    return (fake.client as any).rpc('rpc_begin_fiscal_transmission', {
      p_fiscal_document_id: fiscalDocumentId, p_claim_token: claimToken,
      p_request_payload: { fake: true }, p_fiscal_context_snapshot: { fake: true },
    })
  }

  it('(1) begin com lease válida → sucesso, submission_started_at gravado', async () => {
    const fake = setupFake()
    const ref = buildProviderRef(COMPANY_ID, SALE_ID)
    const claimed = await claim(fake, ref)
    expect(claimed.decision).toBe('claimed')

    const res = await begin(fake, claimed.id, claimed.submission_claim_token)
    expect(res.data).toHaveLength(1)
    expect(res.data[0].submission_started_at).toBeTruthy()
  })

  it('(2) begin com lease JÁ EXPIRADA (mesmo claim_token, ninguém mais reclamou) → zero linhas — este é exatamente o bug real reportado (lease 02:40:01, begin às 02:40:21)', async () => {
    const fake = setupFake()
    const ref = buildProviderRef(COMPANY_ID, SALE_ID)
    const claimed = await claim(fake, ref)

    // Simula o worker demorando mais que a lease ANTES de sequer chamar
    // begin (GC/thread stall, debugger pausado, contêiner com throttling)
    // — ninguém mais reclamou ainda, o token continua sendo o mesmo.
    const row = fake.tables.fiscal_documents.find((r) => r.id === claimed.id)
    row.submission_lease_until = new Date(Date.now() - 1000).toISOString()

    const res = await begin(fake, claimed.id, claimed.submission_claim_token)
    expect(res.data).toEqual([]) // ANTES desta correção, isto teria sucesso — era o bug.

    // A linha nunca foi alterada pelo begin recusado.
    expect(row.submission_started_at).toBeFalsy()
  })

  it('(3) segundo begin com o MESMO claim_token (já iniciado antes) → zero linhas, nunca reabre/reafirma', async () => {
    const fake = setupFake()
    const ref = buildProviderRef(COMPANY_ID, SALE_ID)
    const claimed = await claim(fake, ref)

    const first = await begin(fake, claimed.id, claimed.submission_claim_token)
    expect(first.data).toHaveLength(1)
    const startedAtFirst = first.data[0].submission_started_at

    const second = await begin(fake, claimed.id, claimed.submission_claim_token)
    expect(second.data).toEqual([]) // recusado — submission_started_at já não é NULL

    const row = fake.tables.fiscal_documents.find((r) => r.id === claimed.id)
    expect(row.submission_started_at).toBe(startedAtFirst) // nunca foi reescrito pela segunda chamada
  })

  it('(4) claim novo após expiração → token ANTIGO não consegue begin (mesmo se tentar depois)', async () => {
    const fake = setupFake()
    const ref = buildProviderRef(COMPANY_ID, SALE_ID)
    const claimedA = await claim(fake, ref)
    const tokenA = claimedA.submission_claim_token

    // Expira a lease de A sem nenhuma transmissão despachada (submission_started_at
    // continua NULL) — nenhuma evidência de transmissão anterior, claim novo é seguro.
    const row = fake.tables.fiscal_documents.find((r) => r.id === claimedA.id)
    row.submission_lease_until = new Date(Date.now() - 1000).toISOString()

    const claimedB = await claim(fake, ref)
    expect(claimedB.decision).toBe('claimed')
    expect(claimedB.submission_claim_token).not.toBe(tokenA)

    // A ("antigo"), mesmo tentando begin DEPOIS de B já ter reclamado, é recusado.
    const staleAttempt = await begin(fake, claimedA.id, tokenA)
    expect(staleAttempt.data).toEqual([])
  })

  it('(5) token NOVO (o claim B do teste acima) consegue begin normalmente', async () => {
    const fake = setupFake()
    const ref = buildProviderRef(COMPANY_ID, SALE_ID)
    const claimedA = await claim(fake, ref)
    const row = fake.tables.fiscal_documents.find((r) => r.id === claimedA.id)
    row.submission_lease_until = new Date(Date.now() - 1000).toISOString()
    const claimedB = await claim(fake, ref)

    const res = await begin(fake, claimedB.id, claimedB.submission_claim_token)
    expect(res.data).toHaveLength(1)
    expect(res.data[0].submission_started_at).toBeTruthy()
  })

  it('(6) worker antigo não consegue sobrescrever o estado pertencente ao claim novo, mesmo depois de B já ter iniciado E concluído a transmissão', async () => {
    const fake = setupFake()
    const ref = buildProviderRef(COMPANY_ID, SALE_ID)
    const claimedA = await claim(fake, ref)
    const tokenA = claimedA.submission_claim_token
    const row = fake.tables.fiscal_documents.find((r) => r.id === claimedA.id)
    row.submission_lease_until = new Date(Date.now() - 1000).toISOString()

    const claimedB = await claim(fake, ref)
    const tokenB = claimedB.submission_claim_token
    await begin(fake, claimedB.id, tokenB)
    await (fake.client as any).rpc('rpc_complete_fiscal_emission', {
      p_fiscal_document_id: claimedB.id, p_claim_token: tokenB, p_status: 'authorized', p_access_key: 'chave-worker-b',
    })

    // A tenta, nesta ordem, begin e complete — ambos devem ser recusados,
    // o resultado de B nunca é sobrescrito.
    const beginStale = await begin(fake, claimedA.id, tokenA)
    expect(beginStale.data).toEqual([])
    const completeStale = await (fake.client as any).rpc('rpc_complete_fiscal_emission', {
      p_fiscal_document_id: claimedA.id, p_claim_token: tokenA, p_status: 'submission_error',
    })
    expect(completeStale.data).toEqual([])

    expect(row.status).toBe('authorized')
    expect(row.access_key).toBe('chave-worker-b')
  })

  it('(7) complete de transmissão legitimamente iniciada continua funcionando MESMO SE a lease expirar depois do begin e antes da resposta chegar', async () => {
    const fake = setupFake()
    const ref = buildProviderRef(COMPANY_ID, SALE_ID)
    const claimed = await claim(fake, ref)
    const beginRes = await begin(fake, claimed.id, claimed.submission_claim_token)
    expect(beginRes.data).toHaveLength(1)

    // A lease expira DEPOIS do begin bem-sucedido (POST demorado) — complete
    // não deve exigir lease ativa (rpc_complete_fiscal_emission nunca checou
    // isso, e não foi alterada nesta revisão).
    const row = fake.tables.fiscal_documents.find((r) => r.id === claimed.id)
    row.submission_lease_until = new Date(Date.now() - 1000).toISOString()

    const completeRes = await (fake.client as any).rpc('rpc_complete_fiscal_emission', {
      p_fiscal_document_id: claimed.id, p_claim_token: claimed.submission_claim_token,
      p_status: 'authorized', p_access_key: 'chave-legitima',
    })
    expect(completeRes.data).toHaveLength(1)
    expect(completeRes.data[0].status).toBe('authorized')
    expect(completeRes.data[0].access_key).toBe('chave-legitima')
  })

  it('(8) timeout/rede após begin mantém submission_started_at (complete com status=pending preserva) e força reconciliation_required na próxima claim', async () => {
    const fake = setupFake()
    const ref = buildProviderRef(COMPANY_ID, SALE_ID)
    const claimed = await claim(fake, ref)
    await begin(fake, claimed.id, claimed.submission_claim_token)

    // Timeout/rede: completa com status='pending' (resultado desconhecido) —
    // rpc_complete_fiscal_emission preserva submission_started_at pra este status.
    await (fake.client as any).rpc('rpc_complete_fiscal_emission', {
      p_fiscal_document_id: claimed.id, p_claim_token: claimed.submission_claim_token,
      p_status: 'pending', p_status_message: 'timeout',
    })

    const row = fake.tables.fiscal_documents.find((r) => r.id === claimed.id)
    expect(row.submission_started_at).toBeTruthy() // preservado, não limpo
    expect(row.submission_lease_until).toBeFalsy() // sempre liberada ao concluir

    const nextClaim = await claim(fake, ref)
    expect(nextClaim.decision).toBe('reconciliation_required') // nunca 'claimed' direto
  })

  it('(9) nenhum cenário permite dois begin bem-sucedidos (logo dois POSTs) pro mesmo documento — reproduz a corrida exata do bug real, prova que fecha', async () => {
    const fake = setupFake()
    const ref = buildProviderRef(COMPANY_ID, SALE_ID)
    const claimedA = await claim(fake, ref)
    const tokenA = claimedA.submission_claim_token

    // Reproduz o bug real: lease de A expira ANTES de A chamar begin
    // (worker lento), e ENQUANTO isso um claim novo (B) já foi concedido.
    const row = fake.tables.fiscal_documents.find((r) => r.id === claimedA.id)
    row.submission_lease_until = new Date(Date.now() - 1000).toISOString()
    const claimedB = await claim(fake, ref)
    const tokenB = claimedB.submission_claim_token

    // Ambos tentam begin — em QUALQUER ordem, no máximo 1 sucede.
    const [resA, resB] = await Promise.all([
      begin(fake, claimedA.id, tokenA),
      begin(fake, claimedB.id, tokenB),
    ])
    const sucessos = [resA, resB].filter((r) => r.data.length > 0)
    expect(sucessos).toHaveLength(1) // nunca 2 — nunca 2 POSTs concorrentes possíveis
    expect(sucessos[0].data[0].submission_claim_token).toBe(tokenB) // só o claim vigente (B) pode vencer

    // E o token antigo (A), especificamente, isolado, continua recusado —
    // prova direta do bug real reportado: lease vencida NUNCA mais é suficiente.
    const staleRetry = await begin(fake, claimedA.id, tokenA)
    expect(staleRetry.data).toEqual([])
  })
})

describe('Proteção contra worker antigo (seção 10 do pedido)', () => {
  afterEach(() => { vi.restoreAllMocks() })

  it('conclusão com claim_token superado nunca sobrescreve o resultado do claim vigente', async () => {
    const fake = setupFake()
    const ref = buildProviderRef(COMPANY_ID, SALE_ID)

    // Claim A.
    const claimA = await (fake.client as any).rpc('rpc_claim_fiscal_emission', {
      p_company_id: COMPANY_ID, p_sale_id: SALE_ID, p_provider_ref: ref, p_environment: 'homologacao', p_lease_seconds: 60,
    })
    const tokenA = claimA.data[0].submission_claim_token
    const fiscalDocumentId = claimA.data[0].id

    // Simula o crash de A: lease expira SEM conclusão. Por si só isso
    // ainda não libera um `claimed` direto (status continua 'pending' —
    // "lease expirou ≠ POST novamente", seção 7 do pedido) — só depois de
    // uma reconciliação que tire o documento de 'pending' um claim novo
    // pode ser concedido. Simula aqui a reconciliação já ter concluído
    // isso (ex.: consulta confirmou "não encontrado" → submission_error).
    const row = fake.tables.fiscal_documents.find((r) => r.id === fiscalDocumentId)
    row.submission_lease_until = new Date(Date.now() - 1000).toISOString()
    row.status = 'submission_error'

    const claimB = await (fake.client as any).rpc('rpc_claim_fiscal_emission', {
      p_company_id: COMPANY_ID, p_sale_id: SALE_ID, p_provider_ref: ref, p_environment: 'homologacao', p_lease_seconds: 60,
    })
    expect(claimB.data[0].decision).toBe('claimed')
    const tokenB = claimB.data[0].submission_claim_token
    expect(tokenB).not.toBe(tokenA)

    // B conclui primeiro com um resultado real.
    await (fake.client as any).rpc('rpc_complete_fiscal_emission', {
      p_fiscal_document_id: fiscalDocumentId, p_claim_token: tokenB, p_status: 'authorized',
      p_access_key: 'chave-do-worker-B',
    })

    // A ("antigo") tenta concluir depois, com o token velho — deve ser recusado.
    const staleAttempt = await (fake.client as any).rpc('rpc_complete_fiscal_emission', {
      p_fiscal_document_id: fiscalDocumentId, p_claim_token: tokenA, p_status: 'submission_error',
      p_submission_error_message: 'resultado do worker A, nunca deveria vencer',
    })
    expect(staleAttempt.data).toEqual([]) // recusado — zero linhas afetadas

    const finalRow = fake.tables.fiscal_documents.find((r) => r.id === fiscalDocumentId)
    expect(finalRow.status).toBe('authorized')
    expect(finalRow.access_key).toBe('chave-do-worker-B')
  })
})

describe('Duas NF-e autorizadas para a mesma venda — claim nunca permite (complementa o UNIQUE parcial)', () => {
  afterEach(() => { vi.restoreAllMocks() })

  it('venda já authorized → claim devolve already_authorized, nunca cria segunda tentativa', async () => {
    const fake = setupFake()
    fake.seedFiscalDocument({
      company_id: COMPANY_ID, sale_id: SALE_ID, document_type: 'nfe', provider: 'focus_nfe',
      environment: 'homologacao', provider_ref: buildProviderRef(COMPANY_ID, SALE_ID), status: 'authorized',
      access_key: 'chave-ja-autorizada',
    })

    const result = await (fake.client as any).rpc('rpc_claim_fiscal_emission', {
      p_company_id: COMPANY_ID, p_sale_id: SALE_ID, p_provider_ref: buildProviderRef(COMPANY_ID, SALE_ID), p_environment: 'homologacao', p_lease_seconds: 60,
    })

    expect(result.data[0].decision).toBe('already_authorized')
    expect(fake.tables.fiscal_documents.filter((r) => r.sale_id === SALE_ID)).toHaveLength(1)
  })
})

describe('Recuperação de crash — cenário E: documento já authorized', () => {
  afterEach(() => { vi.restoreAllMocks() })

  it('via o service completo — nova tentativa devolve o documento existente, ZERO POST /v2/nfe', async () => {
    const fake = setupFake()
    mockHappyPathDependencies()
    fake.seedFiscalDocument({
      company_id: COMPANY_ID, sale_id: SALE_ID, document_type: 'nfe', provider: 'focus_nfe',
      environment: 'homologacao', provider_ref: buildProviderRef(COMPANY_ID, SALE_ID), status: 'authorized',
      access_key: 'chave-ja-autorizada', number: '5', series: '1',
    })

    const issueSpy = vi.spyOn(httpClient, 'issueFocusNfe')
    const consultSpy = vi.spyOn(httpClient, 'consultFocusNfe')

    const result = await submitNfeHomologacao(SALE_ID, COMPANY_ID)

    expect(issueSpy).not.toHaveBeenCalled()
    expect(consultSpy).not.toHaveBeenCalled()
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.data.status).toBe('authorized')
      expect(result.data.accessKey).toBe('chave-ja-autorizada')
    }
  })
})
