// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent, cleanup, waitFor, within } from '@testing-library/react'
import { ColorGroupsManager } from './ColorGroupsManager'

vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn(), info: vi.fn() } }))
vi.mock('next/link', () => ({ default: ({ children, href }: any) => <a href={href}>{children}</a> }))

let payload: any
let calls: Array<{ url: string; method: string; body: any }>

beforeEach(() => {
  payload = {
    migrationPending: false,
    groups: [{ id: 5, name: 'Invisible Low', members: [
      { productId: 1, name: 'Calcinha Invisible Low Rosé', active: true, wholesaleEnabled: true },
      { productId: 2, name: 'Calcinha Invisible Low Beige', active: true, wholesaleEnabled: true },
      { productId: 3, name: 'Calcinha Invisible Low Antiga', active: false, wholesaleEnabled: true },
    ] }],
    ungrouped: [{ id: 10, name: 'Body Preto' }, { id: 11, name: 'Calcinha Invisible Low Preta' }],
    suggestions: [],
  }
  calls = []
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    calls.push({ url, method: init?.method ?? 'GET', body: init?.body ? JSON.parse(String(init.body)) : null })
    return { ok: true, status: 200, json: async () => payload }
  }))
  vi.stubGlobal('confirm', () => true)
})
afterEach(() => { cleanup(); vi.unstubAllGlobals() })

describe('Cores do mesmo modelo — gestão no ERP', () => {
  it('lista os grupos com os produtos vinculados (inclui inativos)', async () => {
    render(<ColorGroupsManager />)
    expect(await screen.findByText('Grupos existentes (1)')).toBeTruthy()
    expect(screen.getByText(/Rosé · Calcinha Invisible Low Beige · Calcinha Invisible Low Antiga/)).toBeTruthy()
    expect(screen.getByText(/3 produtos/)).toBeTruthy()
  })

  it('cria grupo: nome interno + produtos pesquisados; só habilita com nome e 2+ produtos', async () => {
    render(<ColorGroupsManager />)
    await screen.findByText('Criar grupo')
    const create = screen.getByRole('button', { name: /Criar grupo com 0 produtos/ }) as HTMLButtonElement
    expect(create.disabled).toBe(true)

    fireEvent.change(screen.getByPlaceholderText(/Nome interno/), { target: { value: 'Body Liso' } })
    const picker = screen.getAllByPlaceholderText(/Pesquisar produtos sem grupo/)[0]
    fireEvent.change(picker, { target: { value: 'preto' } })
    expect(screen.queryByLabelText('Calcinha Invisible Low Preta')).toBeNull() // filtrado fora
    fireEvent.click(screen.getByLabelText('Body Preto'))
    expect((screen.getByRole('button', { name: /Criar grupo com 1 produto$/ }) as HTMLButtonElement).disabled).toBe(true)

    fireEvent.change(picker, { target: { value: '' } })
    fireEvent.click(screen.getByLabelText('Calcinha Invisible Low Preta'))
    fireEvent.click(screen.getByRole('button', { name: /Criar grupo com 2 produtos/ }))

    await waitFor(() => expect(calls.find((c) => c.method === 'POST')).toBeTruthy())
    expect(calls.find((c) => c.method === 'POST')!.body).toEqual({ name: 'Body Liso', productIds: [10, 11] })
  })

  it('edita o grupo: remove um produto e adiciona outro sem grupo; envia a lista final', async () => {
    render(<ColorGroupsManager />)
    fireEvent.click(await screen.findByRole('button', { name: 'Editar grupo Invisible Low' }))
    fireEvent.click(screen.getByRole('button', { name: 'Remover Calcinha Invisible Low Antiga do grupo' }))

    const editor = screen.getByText('Produtos do grupo (2)').closest('div')!.parentElement!
    fireEvent.click(within(editor).getByLabelText('Calcinha Invisible Low Preta'))
    expect(screen.getByText('Produtos do grupo (3)')).toBeTruthy()

    fireEvent.click(screen.getByRole('button', { name: 'Salvar grupo' }))
    await waitFor(() => expect(calls.find((c) => c.method === 'PATCH')).toBeTruthy())
    const patch = calls.find((c) => c.method === 'PATCH')!
    expect(patch.url).toBe('/api/configuracoes/atacado/cores/5')
    expect(patch.body).toEqual({ name: 'Invisible Low', productIds: [1, 2, 11] })
  })

  it('desfazer o grupo chama DELETE e não toca nos produtos', async () => {
    render(<ColorGroupsManager />)
    fireEvent.click(await screen.findByRole('button', { name: 'Desfazer grupo Invisible Low' }))
    await waitFor(() => expect(calls.find((c) => c.method === 'DELETE')).toBeTruthy())
    expect(calls.find((c) => c.method === 'DELETE')!.url).toBe('/api/configuracoes/atacado/cores/5')
  })

  it('sem a migration mostra o aviso e esconde a gestão (sem erro)', async () => {
    payload = { migrationPending: true, groups: [], ungrouped: [], suggestions: [] }
    render(<ColorGroupsManager />)
    expect(await screen.findByText(/migration/)).toBeTruthy()
    expect(screen.queryByText('Criar grupo')).toBeNull()
  })
})
