// Verificação de persistência dos campos fiscais na importação de produtos.
//
// Por quê: rpc_import_products_batch → _persist_single_product só grava
// ncm/origem/cst se a migration 202608311203_import_products_wholesale_fiscal_fields.sql
// estiver aplicada. Numa versão anterior da função o INSERT ignora essas chaves
// SEM erro: a importação "dá certo" (201) e os produtos ficam com NCM/origem NULL.
// Depois do RPC o servidor relê os produtos recém-criados e compara com o que foi
// enviado. NADA é corrigido/preenchido depois: se algum campo informado foi
// descartado, a importação é reportada como falha (nunca como sucesso).

export type FiscalExpectation = { id: number; ncm: string | null; origem: number | null; cst: string | null }

export type FiscalVerifyResult = {
  /** campos informados no arquivo que o banco não gravou como enviado */
  unresolved: { id: number; field: 'ncm' | 'origem' | 'cst'; expected: string | number; found: string | number | null }[]
}

type Row = { id: number; ncm: string | null; origem: number | null; cst: string | null }

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function verifyFiscalPersisted(admin: any, companyId: number, expected: FiscalExpectation[]): Promise<FiscalVerifyResult> {
  const wanted = expected.filter(e => e.ncm !== null || e.origem !== null || e.cst !== null)
  if (wanted.length === 0) return { unresolved: [] }

  const { data, error } = await admin
    .from('products').select('id, ncm, origem, cst')
    .eq('company_id', companyId).in('id', wanted.map(w => w.id))
  if (error) throw new Error(`Não foi possível conferir os dados fiscais gravados: ${error.message}`)
  const rows = new Map((data as Row[]).map(r => [r.id, r]))

  const unresolved: FiscalVerifyResult['unresolved'] = []
  for (const w of wanted) {
    const cur = rows.get(w.id)
    if (!cur) { // produto devolvido pelo RPC mas ilegível aqui: trata como não confirmado
      if (w.ncm !== null) unresolved.push({ id: w.id, field: 'ncm', expected: w.ncm, found: null })
      if (w.origem !== null) unresolved.push({ id: w.id, field: 'origem', expected: w.origem, found: null })
      if (w.cst !== null) unresolved.push({ id: w.id, field: 'cst', expected: w.cst, found: null })
      continue
    }
    if (w.ncm !== null && cur.ncm !== w.ncm) unresolved.push({ id: w.id, field: 'ncm', expected: w.ncm, found: cur.ncm })
    if (w.origem !== null && cur.origem !== w.origem) unresolved.push({ id: w.id, field: 'origem', expected: w.origem, found: cur.origem })
    if (w.cst !== null && cur.cst !== w.cst) unresolved.push({ id: w.id, field: 'cst', expected: w.cst, found: cur.cst })
  }
  return { unresolved }
}

/** Mensagem compreensível para erro de RPC ausente/desatualizada no banco. */
export function describeRpcError(rpcName: string, migration: string, err: { code?: string | null; message: string }): string {
  const missing = err.code === 'PGRST202' || err.code === '42883' || /could not find the function|does not exist/i.test(err.message)
  if (!missing) return err.message
  return `A função ${rpcName} não existe neste banco (migration ${migration} não aplicada). Aplique a migration antes de importar.`
}
