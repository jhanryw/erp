import { describe, it, expect } from 'vitest'
import { createFakeAdmin } from '@/services/wholesale/fakeSupabase.testutil'
import { listSuppliersForFilter, parseSupplierFilter } from './filter'

describe('parseSupplierFilter', () => {
  it('aceita só inteiro positivo; qualquer outra coisa = Todos (undefined)', () => {
    expect(parseSupplierFilter('12')).toBe(12)
    expect(parseSupplierFilter(['7', '9'])).toBe(7)
    for (const bad of [undefined, null, '', '0', '-3', '1.5', 'abc', '12abc', '1 OR 1=1', '99999999999', '2147483648', '007']) {
      expect(parseSupplierFilter(bad as any)).toBeUndefined()
    }
  })
})

describe('listSuppliersForFilter', () => {
  const admin = () => createFakeAdmin({ suppliers: [
    { id: 1, company_id: 1, name: 'Maria José', active: true },
    { id: 2, company_id: 1, name: 'Doce Morena', active: true },
    { id: 3, company_id: 1, name: 'Fornecedor Inativo', active: false },
    { id: 4, company_id: 2, name: 'Fornecedor de Outra Empresa', active: true },
  ] }) as any

  it('só fornecedores ATIVOS da empresa da sessão, ordenados por nome', async () => {
    expect((await listSuppliersForFilter(admin(), 1)).map((s) => s.name)).toEqual(['Doce Morena', 'Maria José'])
  })
  it('nunca devolve fornecedor de outro tenant', async () => {
    expect((await listSuppliersForFilter(admin(), 1)).some((s) => s.id === 4)).toBe(false)
    expect((await listSuppliersForFilter(admin(), 2)).map((s) => s.id)).toEqual([4])
  })
})
