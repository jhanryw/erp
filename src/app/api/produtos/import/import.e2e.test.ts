// E2E real da importação (parser da página → rotas GET → POST /api/produtos/import → RPCs → PostgreSQL).
// Só roda com um banco de teste descartável + PostgREST:
//   E2E_DB="psql -h 127.0.0.1 -p 55432 -U postgres -d erp" E2E_REST=http://127.0.0.1:3999 E2E_KEY=<jwt service_role> \
//   E2E_CSV=/caminho/arquivo.csv npx vitest run src/app/api/produtos/import/import.e2e.test.ts
import { describe, it, expect, vi, beforeAll } from 'vitest'
import { execSync } from 'node:child_process'
import fs from 'node:fs'
import Papa from 'papaparse'
import * as xlsx from 'xlsx'

vi.mock('@/lib/supabase/session', () => ({
  requireRole: async () => ({ user: { id: '00000000-0000-0000-0000-0000000000aa', company_id: 1, role: 'admin' }, response: null }),
}))
vi.mock('@/lib/audit/log', () => ({ auditLog: () => {} }))

const E2E_DB = process.env.E2E_DB
const CSV = process.env.E2E_CSV
const run = E2E_DB && CSV && process.env.E2E_REST && process.env.E2E_KEY ? describe : describe.skip

const sql = (q: string) => execSync(`${E2E_DB} -At -F '|' -c "${q.replace(/"/g, '\\"')}"`, { encoding: 'utf8', env: { ...process.env, LC_ALL: 'en_US.UTF-8' } }).trim()

type Json = Record<string, any>
async function call(handler: (r: Request) => Promise<Response>, url: string, body?: unknown) {
  const res = await handler(new Request('http://x' + url, body ? { method: 'POST', body: JSON.stringify(body) } : undefined))
  return { status: res.status, json: (await res.json()) as Json }
}

/** Reproduz handleFileSelect + useEffect + handleImport de produtos/importar/page.tsx. */
async function importFile(rows: any[]) {
  const { parseImportRows } = await import('@/lib/utils/import-parser')
  const { matchProductType } = await import('@/lib/sku/resolve-taxonomy')
  const cats = await import('@/app/api/categorias/route')
  const supps = await import('@/app/api/fornecedores/route')
  const vars = await import('@/app/api/variacoes/route')
  const names = await import('@/app/api/produtos/names/route')
  const tipos = await import('@/app/api/produtos/tipos/route')
  const modelo = await import('@/app/api/produtos/modelo-options/route')
  const imp = await import('./route')

  const c = (await call(cats.GET as any, '/api/categorias')).json
  const s = (await call(supps.GET as any, '/api/fornecedores')).json
  const v = (await call(vars.GET as any, '/api/variacoes')).json
  const n = (await call(names.GET as any, '/api/produtos/names')).json
  const t = (await call(tipos.GET as any, '/api/produtos/tipos')).json
  for (const [k, j] of Object.entries({ c, s, v, n, t })) if ((j as Json).error) throw new Error(`GET ${k}: ${JSON.stringify(j)}`)
  const colorType = (v.types ?? []).find((x: any) => x.slug === 'cor')
  const sizeType = (v.types ?? []).find((x: any) => x.slug === 'tamanho')
  const dbData: any = {
    categories: c.categories ?? [], suppliers: s.suppliers ?? [],
    colors: colorType?.variation_values ?? [], sizes: sizeType?.variation_values ?? [],
    existingProducts: n.products ?? [], productTypes: t.product_types ?? [],
    modeloGovernanceByTipoSlug: {}, modeloExplicitlyNotUsedTipoSlugs: new Set<string>(),
  }
  for (const tipoInput of new Set(rows.map(r => String(r.tipo || '').trim()).filter(Boolean))) {
    const m = matchProductType(tipoInput, dbData.productTypes)
    if (!m || dbData.modeloGovernanceByTipoSlug[m.slug]) continue
    const j = (await call(modelo.GET as any, `/api/produtos/modelo-options?tipo=${encodeURIComponent(m.slug)}`)).json
    if (j.governed) dbData.modeloGovernanceByTipoSlug[m.slug] = { required: !!j.required, values: (j.values ?? []).map((x: any) => ({ id: x.id, value: x.value, slug: x.slug, sku_code: x.sku_code })) }
    else if (j.configured) dbData.modeloExplicitlyNotUsedTipoSlugs.add(m.slug)
  }
  const parsed = parseImportRows(rows, dbData)
  if (parsed.hasErrors) return { parsed, response: null as any }
  const response = await call(imp.POST as any, '/api/produtos/import', {
    products: parsed.parsedProducts, updates: parsed.parsedUpdates, idempotency_key: crypto.randomUUID(),
  })
  return { parsed, response }
}

const csvRows = () => Papa.parse(fs.readFileSync(CSV!, 'utf8'), { header: true, skipEmptyLines: true }).data as any[]
const xlsxRows = (numeric = false) => {
  const rows = csvRows().map(r => numeric
    ? { ...r, ncm: Number(r.ncm), origem_fiscal: Number(r.origem_fiscal), ano: Number(r.ano), preco: Number(r.preco), custo: Number(r.custo), estoque_inicial: Number(r.estoque_inicial), ativo: true }
    : r)
  const ws = xlsx.utils.json_to_sheet(rows)
  const wb = xlsx.utils.book_new(); xlsx.utils.book_append_sheet(wb, ws, 'S')
  const buf = xlsx.write(wb, { type: 'buffer', bookType: 'xlsx' })
  const back = xlsx.read(buf, { type: 'buffer' })
  return xlsx.utils.sheet_to_json(back.Sheets[back.SheetNames[0]]) as any[]
}

const psqlFile = (f: string) => execSync(`${E2E_DB} -q -v ON_ERROR_STOP=1 -f '${f}'`, { encoding: 'utf8', env: { ...process.env, LC_ALL: 'en_US.UTF-8' } })
const resetProducts = () => { sql('truncate products cascade') }
const fiscalDump = () => sql(`select ncm, origem, origin, coalesce(cst,'<null>'), count(*) from products group by 1,2,3,4 order by 1`)
const EXPECTED_DUMP = ['61082100|0|third_party|<null>|4', '61082200|0|third_party|<null>|4', '62121000|0|third_party|<null>|5'].join('\n')
const FISCAL_FN_OK = 'supabase/migrations/202608311203_import_products_wholesale_fiscal_fields.sql'

run('importação real CSV/XLSX → PostgreSQL', () => {
  beforeAll(() => {
    if (process.env.E2E_ALLOW_TRUNCATE !== '1') throw new Error('Defina E2E_ALLOW_TRUNCATE=1: este teste apaga products no banco E2E_DB (use SÓ banco descartável).')
    process.env.NEXT_PUBLIC_SUPABASE_URL = process.env.E2E_REST
    process.env.SUPABASE_SERVICE_ROLE_KEY = process.env.E2E_KEY
    psqlFile(FISCAL_FN_OK)
  })

  it('CSV: 27 linhas → 13 produtos/27 variações; NCM e origem fiscal 0 persistidos; origem comercial independente', async () => {
    resetProducts()
    const rows = csvRows()
    expect(rows).toHaveLength(27)
    const { parsed, response } = await importFile(rows)
    expect([...new Set(parsed.issues.map(i => i.type + ': ' + i.message))]).toEqual([])
    expect(response.status).toBe(201)
    expect(response.json.created).toBe(13)
    expect(response.json.fiscal).toEqual({ unresolved: [] })
    expect(response.json.fiscal_error).toBeNull()
    expect(sql('select count(*) from product_variations')).toBe('27')
    expect(fiscalDump()).toBe(EXPECTED_DUMP)
    expect(sql(`select count(*) from products where ncm is null or origem is distinct from 0 or origin::text <> 'third_party'`)).toBe('0')
  })

  it('reimportar o mesmo arquivo: bloqueado com mensagem clara, nada alterado nem apagado', async () => {
    const before = fiscalDump()
    const { parsed } = await importFile(csvRows())
    expect(parsed.hasErrors).toBe(true)
    expect(parsed.issues.some(i => /já existe no ERP/.test(i.message))).toBe(true)
    expect(fiscalDump()).toBe(before)
    expect(sql('select count(*) from products')).toBe('13')
  })

  it('XLSX com células de texto e com células numéricas (Excel): mesmo resultado', async () => {
    for (const rows of [xlsxRows(), xlsxRows(true)]) {
      resetProducts()
      const { parsed, response } = await importFile(rows)
      expect([...new Set(parsed.issues.map(i => i.type + ': ' + i.message))]).toEqual([])
      expect(response.status).toBe(201)
      expect(sql('select count(*) from product_variations')).toBe('27')
      expect(fiscalDump()).toBe(EXPECTED_DUMP)
    }
  })

  it('CSV com cabeçalhos alternativos (NCM, Origem Fiscal, CST) e CST vazio', async () => {
    resetProducts()
    const rows = csvRows().map(r => ({ ...r, NCM: r.ncm, 'Origem Fiscal': r.origem_fiscal, CST: '' }))
    rows.forEach(r => { delete (r as any).ncm; delete (r as any).origem_fiscal; delete (r as any).cst })
    const { parsed, response } = await importFile(rows)
    expect(parsed.hasErrors).toBe(false)
    expect(response.status).toBe(201)
    expect(fiscalDump()).toBe(EXPECTED_DUMP)
  })

  it('atualização por SKU: PATCH — célula vazia não apaga, origem 0 e NCM novo persistem, produto e variações preservam fiscal', async () => {
    resetProducts()
    await importFile(csvRows())
    const [skuA, skuB] = sql(`select sku_variation from product_variations pv join products p on p.id=pv.product_id where p.name='Calcinha Cotton Preto' order by pv.id limit 2`).split('\n')
    // 1) só preço, colunas fiscais vazias → fiscal intacto
    let r = await importFile([{ sku: skuA, preco: '29.90', ncm: '', origem_fiscal: '', cst: '' }])
    expect(r.response.status).toBe(201); expect(r.response.json.updated).toBe(1)
    expect(sql(`select ncm||'|'||origem from products where name='Calcinha Cotton Preto'`)).toBe('61082100|0')
    // 2) muda só o NCM → origem 0 preservada
    r = await importFile([{ sku: skuB, ncm: '6108.29.00' }])
    expect(r.response.json.updated).toBe(1)
    expect(sql(`select ncm||'|'||origem from products where name='Calcinha Cotton Preto'`)).toBe('61082900|0')
    // 3) origem 0 → 2 → 0 (0 é valor, não "vazio")
    await importFile([{ sku: skuA, origem_fiscal: '2' }])
    expect(sql(`select origem from products where name='Calcinha Cotton Preto'`)).toBe('2')
    await importFile([{ sku: skuA, origem_fiscal: '0' }])
    expect(sql(`select origem from products where name='Calcinha Cotton Preto'`)).toBe('0')
    // 4) demais produtos não foram tocados
    expect(sql(`select count(*) from products where ncm is null or origem is distinct from 0`)).toBe('0')
  })

  it('banco SEM a migration fiscal (função antiga ignora ncm/origem): NÃO é sucesso — fiscal_error, nada preenchido depois', async () => {
    resetProducts()
    psqlFile(process.env.E2E_OLD_PERSIST ?? '/dev/null')
    try {
      const { response } = await importFile(csvRows())
      expect(response.json.fiscal.unresolved.length).toBeGreaterThanOrEqual(13)
      expect(response.json.fiscal_error).toMatch(/NÃO foram gravados/)
      expect(sql(`select count(*) from products where ncm is not null or origem is not null`)).toBe('0') // sem reparo posterior
    } finally {
      psqlFile(FISCAL_FN_OK) // restaura
    }
  })

  it('RPC inexistente: mensagem compreensível (não o texto cru do PostgREST)', async () => {
    resetProducts()
    sql(`drop function public.rpc_update_products_by_sku_batch(int, uuid, jsonb, text)`)
    try {
      const { response } = await importFile([{ sku: 'X-1', preco: '10' }])
      expect(response.json.update_blocked_error).toMatch(/migration 20260901_rpc_update_products_by_sku\.sql não aplicada/)
    } finally {
      psqlFile('supabase/migrations/20260901_rpc_update_products_by_sku.sql')
    }
  })
})

// CSV mínimo de validação em produção (docs/testes/importacao-teste-fiscal.csv): valores esperados = os do SQL de conferência.
const runMin = E2E_DB && process.env.E2E_CSV_MIN && process.env.E2E_REST && process.env.E2E_KEY ? describe : describe.skip
runMin('CSV mínimo de teste fiscal (2 produtos)', () => {
  it('grava NCM, origem fiscal (0 e 2), CST, preço de atacado direto pela importação — sem UPDATE posterior', async () => {
    process.env.NEXT_PUBLIC_SUPABASE_URL = process.env.E2E_REST
    process.env.SUPABASE_SERVICE_ROLE_KEY = process.env.E2E_KEY
    sql(`delete from products where name like 'ZZ TESTE Fiscal%'`)
    const rows = Papa.parse(fs.readFileSync(process.env.E2E_CSV_MIN!, 'utf8'), { header: true, skipEmptyLines: true }).data as any[]
    const { parsed, response } = await importFile(rows)
    expect([...new Set(parsed.issues.map(i => i.type + ': ' + i.message))]).toEqual([])
    expect(response.status).toBe(201)
    expect(response.json.fiscal_error).toBeNull()
    expect(sql(`select name||'|'||ncm||'|'||origem||'|'||coalesce(cst,'-')||'|'||wholesale_price||'|'||base_price||'|'||base_cost||'|'||origin||'|'||active from products where name like 'ZZ TESTE Fiscal%' order by name`)).toBe(
      ['ZZ TESTE Fiscal A (apagar)|61082100|0|000|14.90|19.90|8.00|third_party|false',
       'ZZ TESTE Fiscal B (apagar)|61082200|2|-|17.90|24.90|9.50|own_brand|false'].join('\n'))
    expect(sql(`select count(*) from products where name like 'ZZ TESTE Fiscal%' and updated_at <> created_at`)).toBe('0')
    expect(sql(`select count(*) from product_variations pv join products p on p.id=pv.product_id where p.name like 'ZZ TESTE Fiscal%'`)).toBe('4')
    if (!process.env.E2E_KEEP) sql(`delete from products where name like 'ZZ TESTE Fiscal%'`)
  })
})
