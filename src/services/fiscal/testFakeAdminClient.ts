/**
 * Fake in-memory do client admin do Supabase, só pra testes de
 * `submitNfeHomologacao`/`consultNfeStatus` — cobre exatamente os padrões
 * de chamada usados nesses arquivos (select+eq*+order+limit+maybeSingle,
 * insert+select+single com verificação de UNIQUE(provider,provider_ref),
 * update via `.then` thenable, delete, insert de array, `.rpc(...)`).
 * Não é um mock genérico de Supabase — não tentar reaproveitar fora deste
 * escopo.
 *
 * ─── `.rpc('rpc_claim_fiscal_emission'/'rpc_complete_fiscal_emission'/
 *     'rpc_begin_fiscal_transmission')` ──────────────────────────────────
 *
 * Reimplementa a MESMA lógica de decisão das três RPCs SQL (Fase Fiscal
 * 3B, incluindo o fechamento do risco residual #2 — `submission_started_at`
 * força `reconciliation_required` incondicionalmente, independente de
 * lease/status) em JS puro. Isto prova que o SERVICE
 * (`submitNfeHomologacao.ts`) reage corretamente a cada decisão possível —
 * NÃO prova que o Postgres real serializa corretamente sob concorrência
 * de verdade (isso só um teste contra Postgres real, com duas
 * conexões/terminais, pode provar — ver
 * `supabase/tests/rpc_claim_fiscal_emission.concurrency.md`).
 *
 * A "atomicidade" simulada aqui vem de uma propriedade real do JS/Node:
 * as três funções fake (`claimFiscalEmissionFake`/
 * `beginFiscalTransmissionFake`/`completeFiscalEmissionFake`) NÃO têm
 * nenhum `await` dentro da própria seção crítica (leitura + decisão +
 * mutação são 100% síncronas) — então, mesmo chamadas via `Promise.all`,
 * o eventloop de thread única do Node nunca interrompe uma no meio pra
 * rodar a outra. Isso é o suficiente pra testar a lógica de decisão do
 * service com confiança, mas continua sendo uma simulação de
 * single-thread, nunca uma prova de `FOR UPDATE`/MVCC do Postgres.
 *
 * Não é um arquivo `*.test.ts` — é importado pelos testes.
 */

import { vi } from 'vitest'

interface FakeFiscalDocumentRow {
  id: number
  company_id: number
  sale_id: number
  document_type: string
  provider: string
  environment: string
  provider_ref: string
  status: string
  number: string | null
  series: string | null
  access_key: string | null
  authorization_protocol: string | null
  status_sefaz: string | null
  status_message: string | null
  submission_error_code: string | null
  submission_error_message: string | null
  xml_path: string | null
  danfe_path: string | null
  submission_claim_token: string | null
  submission_claimed_at: string | null
  submission_lease_until: string | null
  submission_attempts: number
  submission_started_at: string | null
  [key: string]: unknown
}

export function createFakeAdmin(seed: Record<string, any[]> = {}) {
  const tables: Record<string, any[]> = {
    fiscal_documents: [],
    fiscal_document_items: [],
    company_fiscal_settings: [],
    ...seed,
  }
  let nextId = 1000
  let claimTokenSeq = 0

  function matchesFilters(row: any, filters: Array<[string, any]>) {
    return filters.every(([col, val]) => row[col] === val)
  }

  function builder(table: string) {
    const filters: Array<[string, any]> = []
    let orderDesc = false
    let limitN: number | null = null
    let pendingInsert: any = null
    let pendingUpdate: any = null
    let pendingDelete = false

    function applyFilters() {
      let rows = (tables[table] ?? []).filter((r) => matchesFilters(r, filters))
      if (orderDesc) rows = [...rows].sort((a, b) => b.id - a.id)
      if (limitN != null) rows = rows.slice(0, limitN)
      return rows
    }

    const api: any = {
      select() { return api },
      eq(col: string, val: any) { filters.push([col, val]); return api },
      order() { orderDesc = true; return api },
      limit(n: number) { limitN = n; return api },
      insert(obj: any) { pendingInsert = obj; return api },
      update(obj: any) { pendingUpdate = obj; return api },
      delete() { pendingDelete = true; return api },
      async maybeSingle() {
        const rows = applyFilters()
        return { data: rows[0] ?? null, error: null }
      },
      async single() {
        if (pendingInsert && !Array.isArray(pendingInsert)) {
          if (table === 'fiscal_documents') {
            const dup = tables.fiscal_documents.find((r) => r.provider === pendingInsert.provider && r.provider_ref === pendingInsert.provider_ref)
            if (dup) return { data: null, error: { code: '23505', message: 'duplicate key value violates unique constraint' } }
          }
          const row = { id: nextId++, created_at: new Date(nextId).toISOString(), ...defaultFiscalDocumentFields(table), ...pendingInsert }
          tables[table].push(row)
          return { data: row, error: null }
        }
        const rows = applyFilters()
        return { data: rows[0] ?? null, error: null }
      },
      then(resolve: (v: any) => void) {
        if (pendingUpdate) {
          const rows = applyFilters()
          rows.forEach((r) => Object.assign(r, pendingUpdate))
          resolve({ error: null, data: rows })
          return
        }
        if (pendingDelete) {
          tables[table] = (tables[table] ?? []).filter((r) => !matchesFilters(r, filters))
          resolve({ error: null })
          return
        }
        if (Array.isArray(pendingInsert)) {
          pendingInsert.forEach((obj) => tables[table].push({ id: nextId++, ...obj }))
          resolve({ error: null })
          return
        }
        resolve({ data: applyFilters(), error: null })
      },
    }

    return api
  }

  function defaultFiscalDocumentFields(table: string): Record<string, unknown> {
    if (table !== 'fiscal_documents') return {}
    return {
      submission_claim_token: null,
      submission_claimed_at: null,
      submission_lease_until: null,
      submission_attempts: 0,
      submission_started_at: null,
    }
  }

  function findMostRecentFiscalDocument(companyId: number, saleId: number, documentType: string): FakeFiscalDocumentRow | null {
    const rows = (tables.fiscal_documents as FakeFiscalDocumentRow[]).filter(
      (r) => r.company_id === companyId && r.sale_id === saleId && r.document_type === documentType,
    )
    rows.sort((a, b) => b.id - a.id)
    return rows[0] ?? null
  }

  function claimDecisionRow(decision: string, row: FakeFiscalDocumentRow) {
    return {
      decision,
      id: row.id,
      status: row.status,
      provider_ref: row.provider_ref,
      number: row.number,
      series: row.series,
      access_key: row.access_key,
      authorization_protocol: row.authorization_protocol,
      status_sefaz: row.status_sefaz,
      status_message: row.status_message,
      submission_error_code: row.submission_error_code,
      submission_error_message: row.submission_error_message,
      xml_path: row.xml_path,
      danfe_path: row.danfe_path,
      submission_claim_token: row.submission_claim_token,
      submission_lease_until: row.submission_lease_until,
      submission_attempts: row.submission_attempts,
      submission_started_at: row.submission_started_at,
    }
  }

  // ─── rpc_claim_fiscal_emission (fake) ──────────────────────────────────
  // ZERO await na seção crítica (leitura+decisão+mutação) — ver comentário
  // do topo do arquivo sobre o que isso prova e o que não prova.
  function claimFiscalEmissionFake(params: any) {
    const companyId = params.p_company_id
    const saleId = params.p_sale_id
    const providerRef = params.p_provider_ref
    const environment = params.p_environment
    const leaseSeconds = params.p_lease_seconds ?? 60
    const documentType = params.p_document_type ?? 'nfe'

    let row = findMostRecentFiscalDocument(companyId, saleId, documentType)

    if (!row) {
      const dup = (tables.fiscal_documents as FakeFiscalDocumentRow[]).find((r) => r.provider === 'focus_nfe' && r.provider_ref === providerRef)
      if (dup) {
        row = dup
      } else {
        row = {
          id: nextId++,
          company_id: companyId,
          sale_id: saleId,
          document_type: documentType,
          provider: 'focus_nfe',
          environment,
          provider_ref: providerRef,
          status: 'draft',
          number: null, series: null, access_key: null, authorization_protocol: null,
          status_sefaz: null, status_message: null, submission_error_code: null, submission_error_message: null,
          xml_path: null, danfe_path: null,
          submission_claim_token: null, submission_claimed_at: null, submission_lease_until: null, submission_attempts: 0,
          submission_started_at: null,
        }
        ;(row as any).created_at = new Date(nextId).toISOString()
        tables.fiscal_documents.push(row)
      }
    }

    const now = Date.now()

    if (row.status === 'authorized') return { data: [claimDecisionRow('already_authorized', row)], error: null }
    if (row.status === 'cancelled') return { data: [claimDecisionRow('already_cancelled', row)], error: null }

    const leaseActive = !!row.submission_lease_until && new Date(row.submission_lease_until).getTime() > now
    if (leaseActive) return { data: [claimDecisionRow('busy', row)], error: null }

    // Risco residual #2 (Fase 3B): se uma transmissão HTTP real foi
    // despachada sob o claim mais recente (submission_started_at setado
    // por rpc_begin_fiscal_transmission), a lease expirar sozinha NUNCA
    // autoriza reclamar de novo — sempre força reconciliação,
    // independente de `status`. Ver mesmo comentário na migration SQL.
    if (row.submission_started_at) return { data: [claimDecisionRow('reconciliation_required', row)], error: null }

    // draft/validation_failed/submission_error/authorization_failed/cancellation_failed
    // (ou pending sem transmissão despachada — janela síncrona estreita
    // entre o claim e rpc_begin_fiscal_transmission), lease livre, sem
    // evidência de transmissão anterior → reclama direto. Deliberadamente
    // NÃO checa `status === 'pending'` isoladamente (removido no
    // fechamento do risco residual #2) — o único sinal que força
    // reconciliação agora é `submission_started_at`.
    row.submission_claim_token = `fake-claim-token-${++claimTokenSeq}`
    row.submission_claimed_at = new Date(now).toISOString()
    row.submission_lease_until = new Date(now + leaseSeconds * 1000).toISOString()
    row.submission_attempts = (row.submission_attempts ?? 0) + 1
    row.submission_started_at = null // reseta: este claim novo ainda não iniciou nenhuma transmissão.
    row.status = 'pending'

    return { data: [claimDecisionRow('claimed', row)], error: null }
  }

  // ─── rpc_begin_fiscal_transmission (fake) ──────────────────────────────
  // Marca submission_started_at, guardado por id + claim_token vigente +
  // lease AINDA ativa neste instante + submission_started_at ainda NULL —
  // mesmos 4 predicados do WHERE da RPC real (fechamento da race condition
  // real encontrada em Postgres: lease vencida não bastava pra recusar
  // begin antes desta revisão). NÃO toca status (não é uma conclusão, é o
  // registro de que uma tentativa de despacho HTTP está em curso). Ver
  // rpc_begin_fiscal_transmission na migration SQL pro comportamento real
  // equivalente e a auditoria completa do porquê.
  function beginFiscalTransmissionFake(params: any) {
    const row = (tables.fiscal_documents as FakeFiscalDocumentRow[]).find((r) => r.id === params.p_fiscal_document_id)
    if (!row) return { data: [], error: null }
    if (row.submission_claim_token !== params.p_claim_token) return { data: [], error: null } // token superado — recusa
    const leaseActive = !!row.submission_lease_until && new Date(row.submission_lease_until).getTime() > Date.now()
    if (!leaseActive) return { data: [], error: null } // lease vencida neste instante — recusa (bug real fechado)
    if (row.submission_started_at) return { data: [], error: null } // já iniciada sob este mesmo claim — recusa

    row.submission_started_at = new Date().toISOString()
    row.issued_at = new Date().toISOString()
    if (params.p_request_payload != null) row.request_payload = params.p_request_payload
    if (params.p_fiscal_context_snapshot != null) row.fiscal_context_snapshot = params.p_fiscal_context_snapshot

    return { data: [{ ...row }], error: null }
  }

  // ─── rpc_complete_fiscal_emission (fake) ───────────────────────────────
  function completeFiscalEmissionFake(params: any) {
    const row = (tables.fiscal_documents as FakeFiscalDocumentRow[]).find((r) => r.id === params.p_fiscal_document_id)
    if (!row) return { data: [], error: null }
    if (row.submission_claim_token !== params.p_claim_token) return { data: [], error: null } // token superado — recusa

    row.status = params.p_status
    row.status_sefaz = params.p_status_sefaz ?? null
    row.status_message = params.p_status_message ?? null
    row.submission_error_code = params.p_submission_error_code ?? null
    row.submission_error_message = params.p_submission_error_message ?? null
    row.number = params.p_number ?? null
    row.series = params.p_series ?? null
    row.access_key = params.p_access_key ?? null
    row.authorization_protocol = params.p_authorization_protocol ?? null
    row.xml_path = params.p_xml_path ?? null
    row.danfe_path = params.p_danfe_path ?? null
    if (params.p_provider_payload != null) row.provider_payload = params.p_provider_payload
    if (params.p_request_payload != null) row.request_payload = params.p_request_payload
    if (params.p_fiscal_context_snapshot != null) row.fiscal_context_snapshot = params.p_fiscal_context_snapshot
    if (params.p_issued_at != null) row.issued_at = params.p_issued_at
    if (params.p_authorized_at != null) row.authorized_at = params.p_authorized_at
    // Sempre libera a lease ao concluir — ver comentário da migration
    // 20260826 sobre por que isso vale mesmo pra status='pending'.
    row.submission_lease_until = null
    // Limpa submission_started_at SEMPRE que o status não for 'pending' —
    // fechamento do risco residual #2 (mesma regra da migration SQL): um
    // resultado definitivo conhecido (authorized/submission_error/
    // authorization_failed/etc.) resolve a incerteza que o campo
    // representava. Só 'pending' (timeout/rede, resultado genuinamente
    // desconhecido) preserva o valor.
    if (row.status !== 'pending') row.submission_started_at = null

    return { data: [{ ...row }], error: null }
  }

  async function rpc(name: string, params: any) {
    if (name === 'rpc_claim_fiscal_emission') return claimFiscalEmissionFake(params)
    if (name === 'rpc_complete_fiscal_emission') return completeFiscalEmissionFake(params)
    if (name === 'rpc_begin_fiscal_transmission') return beginFiscalTransmissionFake(params)
    throw new Error(`Fake admin client: RPC não simulada: "${name}". Só rpc_claim_fiscal_emission/rpc_complete_fiscal_emission/rpc_begin_fiscal_transmission têm fake — estenda aqui se precisar de outra.`)
  }

  return {
    client: { from: builder, rpc } as any,
    tables,
    seedFiscalDocument(row: Partial<Record<string, any>>) {
      const full = { id: nextId++, created_at: new Date(nextId).toISOString(), ...defaultFiscalDocumentFields('fiscal_documents'), ...row }
      tables.fiscal_documents.push(full)
      return full
    },
  }
}

export function mockCreateAdminClient(fake: ReturnType<typeof createFakeAdmin>) {
  return vi.fn().mockReturnValue(fake.client)
}
