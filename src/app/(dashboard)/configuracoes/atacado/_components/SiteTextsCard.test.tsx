// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, fireEvent, cleanup } from '@testing-library/react'
import { SiteTextsCard } from './SiteTextsCard'
import { EMPTY_SITE_TEXTS, SITE_TEXT_LIMITS } from '@/services/wholesale/siteTexts'

afterEach(cleanup)

describe('Personalização do site (ERP)', () => {
  it('mostra os 8 campos, com o texto padrão como placeholder e o contador de caracteres', () => {
    render(<SiteTextsCard texts={{ ...EMPTY_SITE_TEXTS, heroTitle: 'Olá' }} onChange={() => {}} />)
    expect(screen.getByRole('heading', { name: 'Personalização do site' })).toBeTruthy()
    expect(screen.getAllByRole('textbox')).toHaveLength(8)
    expect((screen.getByLabelText('Título da seção de categorias') as HTMLInputElement).placeholder).toBe('Nossas categorias')
    expect(screen.getByText(`3/${SITE_TEXT_LIMITS.heroTitle}`)).toBeTruthy()
  })

  it('editar chama onChange com o campo novo e preserva os demais; limpar volta a null (padrão)', () => {
    const onChange = vi.fn()
    render(<SiteTextsCard texts={{ ...EMPTY_SITE_TEXTS, footerText: 'Rodapé' }} onChange={onChange} />)

    fireEvent.change(screen.getByLabelText('Título principal da vitrine'), { target: { value: 'Novo título' } })
    expect(onChange).toHaveBeenLastCalledWith({ ...EMPTY_SITE_TEXTS, footerText: 'Rodapé', heroTitle: 'Novo título' })

    fireEvent.change(screen.getByLabelText('Textos institucionais do rodapé'), { target: { value: '' } })
    expect(onChange).toHaveBeenLastCalledWith({ ...EMPTY_SITE_TEXTS, footerText: null })
  })

  it('limita o tamanho no campo e avisa que o valor do mínimo não vem daqui', () => {
    render(<SiteTextsCard texts={EMPTY_SITE_TEXTS} onChange={() => {}} />)
    expect((screen.getByLabelText('Título principal da vitrine') as HTMLInputElement).maxLength).toBe(SITE_TEXT_LIMITS.heroTitle)
    expect(screen.getByText(/O VALOR do pedido mínimo é o campo/)).toBeTruthy()
  })
})
