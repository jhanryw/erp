/**
 * Service de CRM — Customer Identity (Fase 1).
 *
 * Camada canônica de resolução:
 *   crm_person (identidade omnichannel, sem CPF/fiscal)
 *         ↓ normalização + matching
 *   customer (cliente comercial do ERP — fonte de verdade fiscal/vendas)
 *         ↓
 *   crm_person_customer_links (M:N, já existente — reaproveitada, não recriada)
 *
 * Responsabilidade única deste service: decidir, de forma determinística e
 * auditável, SE e COM QUAL customer uma crm_person deve ser vinculada — e
 * criar o vínculo quando (e só quando) a confiança for alta o bastante.
 * Toda a persistência do vínculo em si continua em
 * `person-customer-links.service.ts` (createPersonCustomerLink já trata
 * unique violation como 409 idempotente — reaproveitado, não duplicado).
 *
 * Hierarquia de confiança (nunca decidida "no escuro" — sempre com base nos
 * sinais realmente disponíveis numa crm_person: telefone/e-mail via
 * crm_channel_identities; CPF só quando explicitamente informado por um
 * fluxo futuro que já o tenha em mãos, ex. sale_checkout — crm_persons
 * nunca guarda CPF por desenho):
 *   EXACT            — CPF válido bate com exatamente 1 customer, e nenhum
 *                       outro sinal (telefone/email) aponta pra um customer
 *                       DIFERENTE (senão vira CONFLICT).
 *   HIGH_CONFIDENCE  — sem CPF disponível, mas telefone e/ou e-mail
 *                       normalizados batem com exatamente 1 customer.
 *   AMBIGUOUS        — o mesmo tipo de sinal (ex.: telefone) bate com 2+
 *                       customers diferentes — não dá pra escolher.
 *   CONFLICT         — sinais de tipos diferentes apontam pra customers
 *                       DIFERENTES (ex.: e-mail bate com o cliente X,
 *                       telefone bate com o cliente Y) — nunca resolvido
 *                       silenciosamente.
 *   NO_MATCH         — nenhum sinal bateu com nenhum customer.
 *
 * Só EXACT e HIGH_CONFIDENCE criam vínculo automaticamente.
 * AMBIGUOUS/CONFLICT/NO_MATCH nunca criam vínculo — o chamador decide o que
 * fazer com a classificação (ex.: script de backfill só reporta).
 *
 * Cliente anônimo (customers.is_anonymous = true) é excluído de TODA busca
 * de candidato — nunca pode ser o alvo de um match automático.
 *
 * Multi-tenant: toda query é escopada por company_id explicitamente (o
 * admin client bypassa RLS — mesmo padrão já usado em todo o projeto,
 * isolamento real é o filtro no código, não o RLS).
 */

import { createAdminClient } from '@/lib/supabase/admin'
import { normalizeE164BR } from '@/lib/utils/phone'
import { validateCPF, cleanCPF } from '@/lib/utils/cpf'
import { listChannelIdentitiesByPerson } from './channel-identities.service'
import {
  createPersonCustomerLink,
  listPersonCustomerLinksByPerson,
} from './person-customer-links.service'
import type { CrmPersonCustomerLink } from '@/types/database.types'
import type { ServiceOutcome } from '../produtos.service'

// ─── Tipos ────────────────────────────────────────────────────────────────────

export type CustomerMatchTier = 'EXACT' | 'HIGH_CONFIDENCE' | 'AMBIGUOUS' | 'CONFLICT' | 'NO_MATCH'

export interface CustomerMatchCandidate {
  customerId: number
  matchedBy: 'cpf' | 'phone' | 'email'
  value: string
}

export interface CustomerMatchResult {
  tier: CustomerMatchTier
  /**
   * EXACT/HIGH_CONFIDENCE: 1 elemento, o vencedor.
   * AMBIGUOUS/CONFLICT: 2+ elementos, os candidatos em disputa (pra relatório/decisão humana).
   * NO_MATCH: vazio.
   */
  candidates: CustomerMatchCandidate[]
}

export interface ResolveCustomerForPersonOptions {
  /** Só relevante quando o chamador já tem um CPF em mãos (ex.: futuro fluxo sale_checkout) — crm_persons nunca guarda CPF. */
  cpf?: string | null
}

export interface LinkOutcome {
  tier: CustomerMatchTier
  /** null quando tier não é EXACT/HIGH_CONFIDENCE — nenhum vínculo foi criado. */
  link: CrmPersonCustomerLink | null
}

const ANONYMOUS_CPF_PLACEHOLDER = '11111111111'

// ─── Helpers internos ─────────────────────────────────────────────────────────

function success<T>(data: T): ServiceOutcome<T> {
  return { ok: true, data }
}

function failure(error: string, status = 500): ServiceOutcome<never> {
  return { ok: false, error, status }
}

/**
 * Normalização de e-mail pra matching: só trim + lowercase, nada mais.
 * Explicitamente NÃO faz heurística de provedor (ex.: ignorar "+tag" ou "."
 * do Gmail) — o valor real do endereço é respeitado como digitado.
 */
export function normalizeEmailForMatching(raw: string | null | undefined): string | null {
  if (!raw) return null
  const trimmed = raw.trim().toLowerCase()
  return trimmed || null
}

function dedupeByCustomer(candidates: CustomerMatchCandidate[]): number[] {
  return Array.from(new Set(candidates.map((c) => c.customerId)))
}

// ─── Resolução (sem efeito colateral) ──────────────────────────────────────────

/**
 * Coleta candidatos a partir dos sinais disponíveis (CPF opcional + todas as
 * identidades de canal ativas da pessoa), busca customers reais (nunca
 * anônimos) da MESMA empresa, e classifica segundo a hierarquia de
 * confiança do cabeçalho do arquivo. Não cria/altera nada — só leitura.
 */
export async function resolveCustomerForPerson(
  personId: number,
  companyId: number,
  options?: ResolveCustomerForPersonOptions,
): Promise<ServiceOutcome<CustomerMatchResult>> {
  const admin = createAdminClient()
  const candidates: CustomerMatchCandidate[] = []

  // ── CPF (só quando o chamador já tem um em mãos) ──────────────────────────
  const cpfClean = options?.cpf ? cleanCPF(options.cpf) : null
  if (cpfClean && cpfClean !== ANONYMOUS_CPF_PLACEHOLDER && validateCPF(cpfClean)) {
    const { data, error } = await (admin as any)
      .from('customers')
      .select('id')
      .eq('company_id', companyId)
      .eq('cpf', cpfClean)
      .eq('is_anonymous', false) as { data: { id: number }[] | null; error: { message: string } | null }
    if (error) return failure(error.message)
    for (const row of data ?? []) candidates.push({ customerId: row.id, matchedBy: 'cpf', value: cpfClean })
  }

  // ── Identidades de canal ativas da pessoa (telefone/e-mail) ───────────────
  const identitiesResult = await listChannelIdentitiesByPerson(personId, companyId)
  if (!identitiesResult.ok) return failure(identitiesResult.error, identitiesResult.status)

  const phoneValues = Array.from(new Set(
    identitiesResult.data
      .filter((i) => i.channel_type === 'whatsapp' || i.channel_type === 'telegram')
      .map((i) => i.value)
      .filter(Boolean),
  ))

  if (phoneValues.length > 0) {
    const { data, error } = await (admin as any)
      .from('customers')
      .select('id, phone_e164')
      .eq('company_id', companyId)
      .eq('is_anonymous', false)
      .in('phone_e164', phoneValues) as { data: { id: number; phone_e164: string }[] | null; error: { message: string } | null }
    if (error) return failure(error.message)
    for (const row of data ?? []) candidates.push({ customerId: row.id, matchedBy: 'phone', value: row.phone_e164 })
  }

  const emailValues = Array.from(new Set(
    identitiesResult.data
      .filter((i) => i.channel_type === 'email')
      .map((i) => normalizeEmailForMatching(i.value))
      .filter((v): v is string => !!v),
  ))

  for (const email of emailValues) {
    // customers.email não tem normalização garantida na escrita — ilike sem
    // wildcard faz comparação exata case-insensitive, sem herdar esse
    // problema pro matching.
    const { data, error } = await (admin as any)
      .from('customers')
      .select('id, email')
      .eq('company_id', companyId)
      .eq('is_anonymous', false)
      .ilike('email', email) as { data: { id: number; email: string }[] | null; error: { message: string } | null }
    if (error) return failure(error.message)
    for (const row of data ?? []) candidates.push({ customerId: row.id, matchedBy: 'email', value: email })
  }

  return success(classify(candidates))
}

/**
 * Puramente síncrona/determinística — separada de resolveCustomerForPerson
 * só pra ser testável sem banco (ver customer-identity.service.test.ts).
 */
export function classify(candidates: CustomerMatchCandidate[]): CustomerMatchResult {
  const cpfMatches = candidates.filter((c) => c.matchedBy === 'cpf')

  if (cpfMatches.length > 0) {
    const distinctCpfCustomers = dedupeByCustomer(cpfMatches)
    if (distinctCpfCustomers.length === 1) {
      const winner = distinctCpfCustomers[0]
      const conflicting = candidates.filter((c) => c.matchedBy !== 'cpf' && c.customerId !== winner)
      if (conflicting.length > 0) {
        return { tier: 'CONFLICT', candidates: [...cpfMatches.filter((c) => c.customerId === winner), ...conflicting] }
      }
      return { tier: 'EXACT', candidates: cpfMatches.filter((c) => c.customerId === winner).slice(0, 1) }
    }
    // CPF batendo com >1 customer não deveria acontecer (CPF é único por
    // empresa) — tratado como ambíguo em vez de escolher um arbitrariamente.
    return { tier: 'AMBIGUOUS', candidates: cpfMatches }
  }

  const nonCpfCandidates = candidates.filter((c) => c.matchedBy !== 'cpf')
  const distinctCustomers = dedupeByCustomer(nonCpfCandidates)

  if (distinctCustomers.length === 0) return { tier: 'NO_MATCH', candidates: [] }

  if (distinctCustomers.length === 1) {
    const winner = distinctCustomers[0]
    return { tier: 'HIGH_CONFIDENCE', candidates: nonCpfCandidates.filter((c) => c.customerId === winner).slice(0, 1) }
  }

  const matchTypes = new Set(nonCpfCandidates.map((c) => c.matchedBy))
  if (matchTypes.size > 1) {
    // tipos de sinal diferentes apontam pra customers diferentes — conflito
    // real, nunca escolhido silenciosamente.
    return { tier: 'CONFLICT', candidates: nonCpfCandidates }
  }

  // mesmo tipo de sinal bate com 2+ customers diferentes — ambíguo.
  return { tier: 'AMBIGUOUS', candidates: nonCpfCandidates }
}

// ─── Linking (com efeito colateral, idempotente) ───────────────────────────────

function matchSourceFor(matchedBy: CustomerMatchCandidate['matchedBy']): 'cpf_match' | 'phone_match' | 'email_match' {
  if (matchedBy === 'cpf') return 'cpf_match'
  if (matchedBy === 'phone') return 'phone_match'
  return 'email_match'
}

/**
 * Resolve e, só quando EXACT ou HIGH_CONFIDENCE, cria o vínculo em
 * crm_person_customer_links. Idempotente: chamar de novo pra uma pessoa já
 * vinculada ao mesmo customer não cria duplicata (nem via SELECT prévio nem
 * via 23505 de corrida — os dois caminhos convergem pro mesmo retorno).
 *
 * is_primary: true só quando é o primeiro vínculo ativo da pessoa. Uma
 * pessoa pode legitimamente acumular vínculos a mais de um customer com o
 * tempo (ex.: WhatsApp compartilhado por duas pessoas da mesma família que
 * compraram separadamente) — o índice único parcial do banco já impede mais
 * de um is_primary=true ativo por pessoa, então nunca inventamos essa
 * garantia aqui, só respeitamos.
 *
 * Esta é a função pensada pra ser reaproveitada no futuro pelo Chatwoot
 * (contato → telefone/email → crm_person → resolveCustomerForPerson →
 * customer) — nenhum endpoint novo foi criado agora, só esta camada.
 */
export async function linkPersonToCustomerIfConfident(
  personId: number,
  companyId: number,
  options?: ResolveCustomerForPersonOptions & { createdBy?: string | null },
): Promise<ServiceOutcome<LinkOutcome>> {
  const resolved = await resolveCustomerForPerson(personId, companyId, options)
  if (!resolved.ok) return failure(resolved.error, resolved.status)

  if (resolved.data.tier !== 'EXACT' && resolved.data.tier !== 'HIGH_CONFIDENCE') {
    return success({ tier: resolved.data.tier, link: null })
  }

  const winner = resolved.data.candidates[0]
  const matchSource = matchSourceFor(winner.matchedBy)

  const existingLinks = await listPersonCustomerLinksByPerson(personId, companyId)
  if (!existingLinks.ok) return failure(existingLinks.error, existingLinks.status)

  const already = existingLinks.data.find((l) => l.customer_id === winner.customerId)
  if (already) return success({ tier: resolved.data.tier, link: already })

  const isPrimary = existingLinks.data.length === 0

  const created = await createPersonCustomerLink({
    companyId,
    personId,
    customerId: winner.customerId,
    matchSource,
    isPrimary,
    createdBy: options?.createdBy ?? null,
  })

  if (created.ok) return success({ tier: resolved.data.tier, link: created.data })

  // 409 = unique violation. Duas causas possíveis sob corrida:
  //  (a) outra chamada concorrente já criou o MESMO vínculo (person+customer)
  //      → idempotente, busca de novo e retorna o que já existe.
  //  (b) outra chamada concorrente ganhou a corrida por is_primary=true pra
  //      esta pessoa (índice único parcial) → retry uma vez com isPrimary=false.
  if (created.status === 409) {
    const retryLinks = await listPersonCustomerLinksByPerson(personId, companyId)
    if (!retryLinks.ok) return failure(retryLinks.error, retryLinks.status)

    const foundNow = retryLinks.data.find((l) => l.customer_id === winner.customerId)
    if (foundNow) return success({ tier: resolved.data.tier, link: foundNow })

    const retryCreated = await createPersonCustomerLink({
      companyId,
      personId,
      customerId: winner.customerId,
      matchSource,
      isPrimary: false,
      createdBy: options?.createdBy ?? null,
    })
    if (!retryCreated.ok) return failure(retryCreated.error, retryCreated.status)
    return success({ tier: resolved.data.tier, link: retryCreated.data })
  }

  return failure(created.error, created.status)
}

// Reexportado por conveniência — mesma função usada pra normalizar telefone
// antes de gravar customers.phone_e164 (ver clientes.service.ts).
export { normalizeE164BR }
