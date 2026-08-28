/**
 * Fundação "mesma venda, dois ambientes" (auditoria homologação → produção,
 * 2026-09-06) — prova que uma NFC-e/NF-e autorizada em homologação nunca
 * bloqueia nem corrompe uma tentativa posterior de autorizar o MESMO
 * document_type em produção pra MESMA venda, e que dentro de um único
 * ambiente a proteção contra duplicidade continua intacta.
 *
 * Cobre a RPC (via o fake que espelha rpc_claim_fiscal_emission real —
 * ver testFakeAdminClient.ts), o provider_ref (buildProviderRef) e o
 * texto da migration 202609061000 (garantia de índice, que só um
 * Postgres real pode aplicar de fato — ver
 * supabase/tests/rpc_claim_fiscal_emission.concurrency.md pro roteiro
 * manual equivalente).
 *
 * NÃO testa liberação de produção — o gate em submitNfeHomologacao.ts/
 * submitNfceHomologacao.ts continua recusando qualquer ambiente que não
 * seja 'homologacao' (ver describe dedicado no fim deste arquivo).
 */

import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { buildProviderRef } from './submitNfeHomologacao'
import { createFakeAdmin } from './testFakeAdminClient'

const MIGRATION_PATH = join(__dirname, '..', '..', '..', 'supabase', 'migrations', '202609061000_fiscal_documents_environment_scoped_authorization.sql')
const MIGRATION_SQL = readFileSync(MIGRATION_PATH, 'utf-8')

const COMPANY_ID = 1
const SALE_ID = 642

describe('buildProviderRef — homologação e produção nunca compartilham ref (item 4/6/7/8 do pedido)', () => {
  it('formato inclui o ambiente no sufixo', () => {
    expect(buildProviderRef(COMPANY_ID, SALE_ID, 'homologacao', 'nfce')).toBe('qarvon-1-642-nfce-homologacao')
    expect(buildProviderRef(COMPANY_ID, SALE_ID, 'producao', 'nfce')).toBe('qarvon-1-642-nfce-producao')
  })

  it('homologação e produção nunca colidem pra mesma venda+tipo', () => {
    const homolog = buildProviderRef(COMPANY_ID, SALE_ID, 'homologacao', 'nfce')
    const producao = buildProviderRef(COMPANY_ID, SALE_ID, 'producao', 'nfce')
    expect(homolog).not.toBe(producao)
  })

  it('retry dentro do MESMO ambiente usa exatamente a mesma ref (idempotência preservada)', () => {
    expect(buildProviderRef(COMPANY_ID, SALE_ID, 'homologacao', 'nfce')).toBe(buildProviderRef(COMPANY_ID, SALE_ID, 'homologacao', 'nfce'))
    expect(buildProviderRef(COMPANY_ID, SALE_ID, 'producao', 'nfce')).toBe(buildProviderRef(COMPANY_ID, SALE_ID, 'producao', 'nfce'))
  })

  it('NF-e e NFC-e continuam independentes dentro do mesmo ambiente', () => {
    const nfce = buildProviderRef(COMPANY_ID, SALE_ID, 'homologacao', 'nfce')
    const nfe = buildProviderRef(COMPANY_ID, SALE_ID, 'homologacao', 'nfe')
    expect(nfce).not.toBe(nfe)
  })
})

describe('rpc_claim_fiscal_emission (fake) — environment na identidade da linha (item 1/2/3 do pedido, testes 1-8 da lista)', () => {
  it('1) sale 642 nfce homologação authorized → novo claim homologação → already_authorized', async () => {
    const fake = createFakeAdmin()
    fake.seedFiscalDocument({
      company_id: COMPANY_ID, sale_id: SALE_ID, document_type: 'nfce', environment: 'homologacao',
      provider: 'focus_nfe', provider_ref: buildProviderRef(COMPANY_ID, SALE_ID, 'homologacao', 'nfce'), status: 'authorized',
    })

    const result = await fake.client.rpc('rpc_claim_fiscal_emission', {
      p_company_id: COMPANY_ID, p_sale_id: SALE_ID,
      p_provider_ref: buildProviderRef(COMPANY_ID, SALE_ID, 'homologacao', 'nfce'),
      p_environment: 'homologacao', p_document_type: 'nfce',
    })
    expect(result.data[0].decision).toBe('already_authorized')
  })

  it('2) sale 642 nfce homologação authorized → claim produção → cria linha NOVA e independente (claimed, nunca already_authorized)', async () => {
    const fake = createFakeAdmin()
    const homolog = fake.seedFiscalDocument({
      company_id: COMPANY_ID, sale_id: SALE_ID, document_type: 'nfce', environment: 'homologacao',
      provider: 'focus_nfe', provider_ref: buildProviderRef(COMPANY_ID, SALE_ID, 'homologacao', 'nfce'), status: 'authorized',
    })

    const result = await fake.client.rpc('rpc_claim_fiscal_emission', {
      p_company_id: COMPANY_ID, p_sale_id: SALE_ID,
      p_provider_ref: buildProviderRef(COMPANY_ID, SALE_ID, 'producao', 'nfce'),
      p_environment: 'producao', p_document_type: 'nfce',
    })
    expect(result.data[0].decision).toBe('claimed')
    expect(result.data[0].id).not.toBe(homolog.id)

    // A linha de homologação nunca é tocada por este claim de produção.
    const stillHomolog = fake.tables.fiscal_documents.find((r: any) => r.id === homolog.id)
    expect(stillHomolog.status).toBe('authorized')
    expect(stillHomolog.environment).toBe('homologacao')
  })

  it('3) mesma venda: nfce homologação authorized + nfce produção authorized → schema permite (2 linhas independentes coexistindo)', () => {
    const fake = createFakeAdmin()
    fake.seedFiscalDocument({
      company_id: COMPANY_ID, sale_id: SALE_ID, document_type: 'nfce', environment: 'homologacao',
      provider: 'focus_nfe', provider_ref: buildProviderRef(COMPANY_ID, SALE_ID, 'homologacao', 'nfce'), status: 'authorized',
    })
    fake.seedFiscalDocument({
      company_id: COMPANY_ID, sale_id: SALE_ID, document_type: 'nfce', environment: 'producao',
      provider: 'focus_nfe', provider_ref: buildProviderRef(COMPANY_ID, SALE_ID, 'producao', 'nfce'), status: 'authorized',
    })

    const authorizedRows = fake.tables.fiscal_documents.filter(
      (r: any) => r.sale_id === SALE_ID && r.document_type === 'nfce' && r.status === 'authorized',
    )
    expect(authorizedRows).toHaveLength(2)
    expect(authorizedRows.map((r: any) => r.environment).sort()).toEqual(['homologacao', 'producao'])
  })

  it('7) retry homologação: reclama a MESMA linha existente, provider_ref permanece idêntico, nunca cria uma segunda', async () => {
    const fake = createFakeAdmin()
    const ref = buildProviderRef(COMPANY_ID, SALE_ID, 'homologacao', 'nfce')
    const seeded = fake.seedFiscalDocument({
      company_id: COMPANY_ID, sale_id: SALE_ID, document_type: 'nfce', environment: 'homologacao',
      provider: 'focus_nfe', provider_ref: ref, status: 'submission_error',
    })

    const result = await fake.client.rpc('rpc_claim_fiscal_emission', {
      p_company_id: COMPANY_ID, p_sale_id: SALE_ID, p_provider_ref: ref, p_environment: 'homologacao', p_document_type: 'nfce',
    })
    expect(result.data[0].decision).toBe('claimed')
    expect(result.data[0].id).toBe(seeded.id)
    expect(result.data[0].provider_ref).toBe(ref)
    expect(fake.tables.fiscal_documents.filter((r: any) => r.sale_id === SALE_ID && r.document_type === 'nfce' && r.environment === 'homologacao')).toHaveLength(1)
  })

  it('8) retry produção: reclama a MESMA linha existente, provider_ref permanece idêntico, nunca cria uma segunda', async () => {
    const fake = createFakeAdmin()
    const ref = buildProviderRef(COMPANY_ID, SALE_ID, 'producao', 'nfce')
    const seeded = fake.seedFiscalDocument({
      company_id: COMPANY_ID, sale_id: SALE_ID, document_type: 'nfce', environment: 'producao',
      provider: 'focus_nfe', provider_ref: ref, status: 'submission_error',
    })

    const result = await fake.client.rpc('rpc_claim_fiscal_emission', {
      p_company_id: COMPANY_ID, p_sale_id: SALE_ID, p_provider_ref: ref, p_environment: 'producao', p_document_type: 'nfce',
    })
    expect(result.data[0].decision).toBe('claimed')
    expect(result.data[0].id).toBe(seeded.id)
    expect(result.data[0].provider_ref).toBe(ref)
  })

  it('duas tentativas de claim homologação concorrentes sobre a MESMA linha nunca "claimed" as duas — a segunda vê lease ativa (busy)', async () => {
    const fake = createFakeAdmin()
    const ref = buildProviderRef(COMPANY_ID, SALE_ID, 'homologacao', 'nfce')

    const first = await fake.client.rpc('rpc_claim_fiscal_emission', {
      p_company_id: COMPANY_ID, p_sale_id: SALE_ID, p_provider_ref: ref, p_environment: 'homologacao', p_document_type: 'nfce',
    })
    const second = await fake.client.rpc('rpc_claim_fiscal_emission', {
      p_company_id: COMPANY_ID, p_sale_id: SALE_ID, p_provider_ref: ref, p_environment: 'homologacao', p_document_type: 'nfce',
    })
    expect(first.data[0].decision).toBe('claimed')
    expect(second.data[0].decision).toBe('busy')
    expect(second.data[0].id).toBe(first.data[0].id)
  })
})

describe('gate de produção — continua recusando (item 13/19 do pedido: NÃO liberar produção nesta fundação)', () => {
  it('submitNfeHomologacao.ts ainda bloqueia environment != homologacao antes de qualquer claim/provider_ref', () => {
    const source = readFileSync(join(__dirname, 'submitNfeHomologacao.ts'), 'utf-8')
    expect(source).toMatch(/if \(settings\.nfe_environment !== 'homologacao'\) \{/)
    expect(source).toMatch(/Bloqueado: esta rota só emite em homologação/)
  })

  it('submitNfceHomologacao.ts ainda bloqueia environment != homologacao antes de qualquer claim/provider_ref', () => {
    const source = readFileSync(join(__dirname, 'submitNfceHomologacao.ts'), 'utf-8')
    expect(source).toMatch(/if \(settings\.nfce_environment !== 'homologacao'\) \{/)
    expect(source).toMatch(/Bloqueado: esta rota só emite em homologação/)
  })
})

describe('migration 202609061000 — texto da DDL (garantia real só um Postgres aplica; aqui só regressão do arquivo)', () => {
  it('cria o índice novo com (company_id, sale_id, document_type, environment)', () => {
    expect(MIGRATION_SQL).toMatch(/CREATE UNIQUE INDEX IF NOT EXISTS uq_fiscal_documents_sale_authorized\s*\n\s*ON public\.fiscal_documents \(company_id, sale_id, document_type, environment\)/)
  })

  it('faz DROP do índice antigo ANTES de recriar (nunca duas versões coexistindo)', () => {
    const dropIdx = MIGRATION_SQL.indexOf('DROP INDEX IF EXISTS public.uq_fiscal_documents_sale_authorized')
    const createIdx = MIGRATION_SQL.indexOf('CREATE UNIQUE INDEX IF NOT EXISTS uq_fiscal_documents_sale_authorized')
    expect(dropIdx).toBeGreaterThan(-1)
    expect(createIdx).toBeGreaterThan(dropIdx)
  })

  it('rpc_claim_fiscal_emission nova filtra por environment nos 2 SELECTs de identidade (inicial + fallback de corrida perdida)', () => {
    const occurrences = [...MIGRATION_SQL.matchAll(/AND environment = p_environment/g)]
    expect(occurrences.length).toBeGreaterThanOrEqual(2)
  })

  it('assinatura da função permanece com os mesmos 6 parâmetros (nenhum DROP FUNCTION necessário/feito)', () => {
    expect(MIGRATION_SQL).toMatch(/CREATE OR REPLACE FUNCTION public\.rpc_claim_fiscal_emission\(/)
    expect(MIGRATION_SQL).not.toMatch(/DROP FUNCTION IF EXISTS public\.rpc_claim_fiscal_emission/)
  })

  it('nunca reescreve dado histórico — nenhum UPDATE toca access_key/provider_ref/environment/status/qrcode_url/protocol de linhas já existentes', () => {
    // O único UPDATE em fiscal_documents nesta migration é o claim de
    // sempre (grava claim_token/lease/attempts + status='pending' na
    // linha que ACABOU de ser reclamada, WHERE fd.id = v_row.id) —
    // comportamento herdado, não uma reescrita retroativa de histórico.
    // Nunca deve existir um UPDATE setando access_key/provider_ref/
    // environment/qrcode_url/authorization_protocol (os campos que o
    // pedido proíbe alterar em documentos existentes).
    const codeOnly = MIGRATION_SQL
      .split('\n')
      .map((line) => line.replace(/--.*$/, ''))
      .join('\n')
    expect(codeOnly).not.toMatch(/SET\s+[\s\S]{0,200}?\baccess_key\s*=/i)
    expect(codeOnly).not.toMatch(/SET\s+[\s\S]{0,200}?\bprovider_ref\s*=/i)
    expect(codeOnly).not.toMatch(/SET\s+[\s\S]{0,200}?\benvironment\s*=/i)
    expect(codeOnly).not.toMatch(/SET\s+[\s\S]{0,200}?\bqrcode_url\s*=/i)
    expect(codeOnly).not.toMatch(/SET\s+[\s\S]{0,200}?\bauthorization_protocol\s*=/i)
    expect(codeOnly).not.toMatch(/DELETE\s+FROM\s+public\.fiscal_documents/i)
  })
})
