import { describe, it, expect, vi, afterEach } from 'vitest'
import { signupWholesaleCustomer, loginWholesaleCustomer } from './customerAuth'
import { createAdminClient } from '@/lib/supabase/admin'
import { createClient } from '@/lib/supabase/server'

vi.mock('@/lib/supabase/admin', () => ({ createAdminClient: vi.fn() }))
vi.mock('@/lib/supabase/server', () => ({ createClient: vi.fn() }))

const BASE_INPUT = { companyId: 1, email: 'loja@x.com', password: 'senha1234', name: 'Loja X', phone: '11999998888' }

function mockAdmin({
  existingCustomer = null as any,
  createUserError = null as { message: string } | null,
  insertError = null as { message: string } | null,
  deleteUserSpy = vi.fn(),
}) {
  ;(createAdminClient as unknown as ReturnType<typeof vi.fn>).mockReturnValue({
    auth: {
      admin: {
        createUser: async () => createUserError
          ? { data: { user: null }, error: createUserError }
          : { data: { user: { id: 'auth-uuid-1' } }, error: null },
        deleteUser: deleteUserSpy,
      },
    },
    from: () => ({
      select: () => ({
        eq: () => ({ or: () => ({ limit: () => ({ maybeSingle: async () => ({ data: existingCustomer }) }) }) }),
      }),
      insert: () => ({
        select: () => ({
          single: async () => insertError
            ? { data: null, error: insertError }
            : { data: { id: 42 }, error: null },
        }),
      }),
      update: () => ({ eq: async () => ({ error: null }) }),
    }),
  })
}

function mockSessionClient(signInError: { message: string } | null = null) {
  ;(createClient as unknown as ReturnType<typeof vi.fn>).mockReturnValue({
    auth: {
      signInWithPassword: async () => ({ data: {}, error: signInError }),
      signOut: async () => {},
    },
  })
}

describe('signupWholesaleCustomer', () => {
  afterEach(() => vi.restoreAllMocks())

  it('Fase 9 hardening: falha de INSERT no customers nunca vaza mensagem crua do Postgres pro cliente', async () => {
    const deleteUserSpy = vi.fn()
    mockAdmin({ insertError: { message: 'duplicate key value violates unique constraint "customers_pkey_internal_detail"' }, deleteUserSpy })
    mockSessionClient()
    const result = await signupWholesaleCustomer(BASE_INPUT)
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.error).not.toContain('constraint')
      expect(result.error).not.toContain('customers_pkey_internal_detail')
    }
    // Rollback: usuário auth.users órfão é removido quando o customers falha.
    expect(deleteUserSpy).toHaveBeenCalledWith('auth-uuid-1')
  })

  it('27/28. cliente novo — cria customers + auth.users + sessão', async () => {
    mockAdmin({})
    mockSessionClient()
    const result = await signupWholesaleCustomer(BASE_INPUT)
    expect(result).toEqual({ ok: true, customerId: 42 })
  })

  it('25. cliente existente (mesmo email/telefone/CPF/CNPJ) sem conta ainda → liga a conta nova ao cadastro existente, nunca duplica', async () => {
    mockAdmin({ existingCustomer: { id: 99, auth_user_id: null } })
    mockSessionClient()
    const result = await signupWholesaleCustomer(BASE_INPUT)
    expect(result).toEqual({ ok: true, customerId: 99 })
  })

  it('cliente existente que JÁ tem conta → rejeita, orienta a fazer login', async () => {
    mockAdmin({ existingCustomer: { id: 99, auth_user_id: 'already-linked' } })
    const result = await signupWholesaleCustomer(BASE_INPUT)
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.status).toBe(409)
  })
})

describe('loginWholesaleCustomer', () => {
  afterEach(() => vi.restoreAllMocks())

  it('26. sessão válida mas SEM customers vinculado (funcionário logado, por exemplo) → nunca autoriza como cliente, faz signOut', async () => {
    const signOutSpy = vi.fn()
    ;(createClient as unknown as ReturnType<typeof vi.fn>).mockReturnValue({
      auth: { signInWithPassword: async () => ({ data: { user: { id: 'staff-uuid' } }, error: null }), signOut: signOutSpy },
    })
    ;(createAdminClient as unknown as ReturnType<typeof vi.fn>).mockReturnValue({
      from: () => ({ select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: null }) }) }) }),
    })
    const result = await loginWholesaleCustomer('staff@x.com', 'senha1234')
    expect(result.ok).toBe(false)
    expect(signOutSpy).toHaveBeenCalled()
  })
})
