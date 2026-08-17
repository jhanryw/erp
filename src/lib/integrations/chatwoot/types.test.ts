import { describe, it, expect } from 'vitest'
import { extractUnverifiedAccountId, extractEventName, extractEmbeddedContact } from './types'

describe('extractUnverifiedAccountId — nunca lança, nunca inventa', () => {
  it('account aninhado ({account: {id}})', () => {
    expect(extractUnverifiedAccountId({ account: { id: 42 } })).toBe('42')
  })

  it('account_id plano', () => {
    expect(extractUnverifiedAccountId({ account_id: 42 })).toBe('42')
  })

  it('prefere account aninhado quando os dois existem (mesmo valor esperado, mas confirma prioridade)', () => {
    expect(extractUnverifiedAccountId({ account: { id: 1 }, account_id: 2 })).toBe('1')
  })

  it('ausente → null', () => {
    expect(extractUnverifiedAccountId({ event: 'contact_created' })).toBeNull()
  })

  it('payload não-objeto → null', () => {
    expect(extractUnverifiedAccountId(null)).toBeNull()
    expect(extractUnverifiedAccountId('string')).toBeNull()
    expect(extractUnverifiedAccountId(42)).toBeNull()
  })

  it('sempre retorna string, mesmo se o id vier numérico', () => {
    expect(extractUnverifiedAccountId({ account_id: 42 })).toBe('42')
    expect(typeof extractUnverifiedAccountId({ account_id: 42 })).toBe('string')
  })
})

describe('extractEventName', () => {
  it('extrai o campo event quando é string', () => {
    expect(extractEventName({ event: 'contact_created' })).toBe('contact_created')
  })

  it('ausente ou tipo errado → null', () => {
    expect(extractEventName({})).toBeNull()
    expect(extractEventName({ event: 123 })).toBeNull()
    expect(extractEventName(null)).toBeNull()
  })
})

describe('extractEmbeddedContact — tenta múltiplos caminhos, nunca inventa', () => {
  it('meta.sender', () => {
    const result = extractEmbeddedContact({ meta: { sender: { id: 7, name: 'Fulano', email: 'a@b.com', phone_number: '+5584999999999' } } })
    expect(result).toEqual({ id: '7', name: 'Fulano', email: 'a@b.com', phone_number: '+5584999999999' })
  })

  it('contact_inbox.contact', () => {
    const result = extractEmbeddedContact({ contact_inbox: { contact: { id: 8 } } })
    expect(result).toEqual({ id: '8', name: null, email: null, phone_number: null })
  })

  it('contact top-level', () => {
    const result = extractEmbeddedContact({ contact: { id: 9, name: 'Ciclana' } })
    expect(result).toEqual({ id: '9', name: 'Ciclana', email: null, phone_number: null })
  })

  it('prioriza meta.sender sobre os outros caminhos quando múltiplos existem', () => {
    const result = extractEmbeddedContact({
      meta: { sender: { id: 1 } },
      contact_inbox: { contact: { id: 2 } },
      contact: { id: 3 },
    })
    expect(result?.id).toBe('1')
  })

  it('nenhum caminho utilizável → null (nunca inventa)', () => {
    expect(extractEmbeddedContact({ event: 'conversation_created', id: 100 })).toBeNull()
    expect(extractEmbeddedContact({})).toBeNull()
    expect(extractEmbeddedContact(null)).toBeNull()
  })
})
