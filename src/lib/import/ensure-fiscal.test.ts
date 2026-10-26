import { describe, it, expect } from 'vitest'
import { verifyFiscalPersisted, describeRpcError } from './ensure-fiscal'

type Row = { id: number; ncm: string | null; origem: number | null; cst: string | null }

function fakeAdmin(rows: Row[]) {
  const writes: unknown[] = []
  const admin = {
    from: () => ({
      select: () => ({ eq: () => ({ in: async (_c: string, ids: number[]) => ({ data: rows.filter(r => ids.includes(r.id)), error: null }) }) }),
      update: (patch: unknown) => { writes.push(patch); throw new Error('verificação não pode escrever no banco') },
    }),
  }
  return { admin, writes }
}

describe('verifyFiscalPersisted (somente leitura)', () => {
  it('tudo gravado como enviado (inclusive origem 0) → sem pendências', async () => {
    const { admin } = fakeAdmin([{ id: 1, ncm: '62121000', origem: 0, cst: '060' }])
    expect(await verifyFiscalPersisted(admin, 1, [{ id: 1, ncm: '62121000', origem: 0, cst: '060' }])).toEqual({ unresolved: [] })
  })

  it('campo informado e descartado pelo banco (NULL) é reportado — nunca preenchido depois', async () => {
    const { admin, writes } = fakeAdmin([{ id: 1, ncm: null, origem: null, cst: null }])
    const r = await verifyFiscalPersisted(admin, 1, [{ id: 1, ncm: '62121000', origem: 0, cst: null }])
    expect(r.unresolved.map(u => u.field)).toEqual(['ncm', 'origem'])
    expect(writes).toHaveLength(0)
  })

  it('valor gravado diferente do enviado é reportado', async () => {
    const { admin } = fakeAdmin([{ id: 1, ncm: '11111111', origem: 2, cst: null }])
    const r = await verifyFiscalPersisted(admin, 1, [{ id: 1, ncm: '62121000', origem: 0, cst: null }])
    expect(r.unresolved).toHaveLength(2)
  })

  it('nada informado no arquivo → nada a verificar', async () => {
    const { admin } = fakeAdmin([{ id: 1, ncm: null, origem: null, cst: null }])
    expect(await verifyFiscalPersisted(admin, 1, [{ id: 1, ncm: null, origem: null, cst: null }])).toEqual({ unresolved: [] })
  })

  it('produto ilegível após o RPC é tratado como não confirmado', async () => {
    const { admin } = fakeAdmin([])
    const r = await verifyFiscalPersisted(admin, 1, [{ id: 9, ncm: '62121000', origem: 0, cst: null }])
    expect(r.unresolved).toHaveLength(2)
  })
})

describe('describeRpcError', () => {
  it('traduz função ausente', () => {
    expect(describeRpcError('rpc_x', 'm.sql', { code: 'PGRST202', message: 'Could not find the function public.rpc_x' })).toMatch(/migration m\.sql não aplicada/)
  })
  it('mantém outros erros', () => {
    expect(describeRpcError('rpc_x', 'm.sql', { code: '23505', message: 'duplicate key' })).toBe('duplicate key')
  })
})
