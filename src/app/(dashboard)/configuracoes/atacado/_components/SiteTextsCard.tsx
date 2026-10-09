'use client'

import { Card } from '@/components/ui/card'
import { SITE_TEXT_LIMITS, type SiteTextKey, type WholesaleSiteTexts } from '@/services/wholesale/siteTexts'

interface FieldDef {
  key: SiteTextKey
  label: string
  placeholder: string
  hint?: string
  multiline?: boolean
}

const FIELDS: FieldDef[] = [
  { key: 'heroTitle', label: 'Título principal da vitrine', placeholder: 'Sem título (só o banner)', hint: 'Aparece no topo da página inicial, acima do banner.' },
  { key: 'heroSubtitle', label: 'Subtítulo principal da vitrine', placeholder: 'Sem subtítulo' },
  { key: 'categoriesTitle', label: 'Título da seção de categorias', placeholder: 'Nossas categorias' },
  { key: 'productsTitle', label: 'Título da seção de produtos', placeholder: 'Sem título' },
  { key: 'addAlsoTitle', label: 'Título da seção "Adicione também"', placeholder: 'Adicione também', hint: 'Aparece no carrinho.' },
  { key: 'minimumOrderNote', label: 'Texto informativo do pedido mínimo', placeholder: 'Ex.: Pedido mínimo para atacado; frete combinado pelo WhatsApp.', multiline: true, hint: 'Texto livre exibido no carrinho. O VALOR do pedido mínimo é o campo "Pedido mínimo (R$)" acima — não é alterado por este texto.' },
  { key: 'emptyMessage', label: 'Mensagem quando não há produtos', placeholder: 'Nenhum produto encontrado.' },
  { key: 'footerText', label: 'Textos institucionais do rodapé', placeholder: 'Ex.: Santtorini — moda íntima por atacado.\nAtendimento de segunda a sexta, 9h às 18h.', multiline: true, hint: 'Substitui o texto padrão do rodapé. Cada linha vira uma linha no site.' },
]

const fieldCls = 'input-base w-full'

export function SiteTextsCard({ texts, onChange }: { texts: WholesaleSiteTexts; onChange: (texts: WholesaleSiteTexts) => void }) {
  function set(key: SiteTextKey, value: string) {
    // '' vira null (padrão) já no estado; o servidor valida e normaliza de novo.
    onChange({ ...texts, [key]: value === '' ? null : value })
  }

  return (
    <Card className="p-5 space-y-4">
      <div>
        <h3 className="text-sm font-semibold text-text-primary">Personalização do site</h3>
        <p className="text-xs text-text-muted">
          Edite os textos do atacado sem mexer em código. Campo vazio = texto padrão. As mudanças valem para o site público assim que você salvar. Apenas texto — HTML não é interpretado.
        </p>
      </div>

      {FIELDS.map((f) => {
        const value = texts[f.key] ?? ''
        const max = SITE_TEXT_LIMITS[f.key]
        const id = `site-text-${f.key}`
        return (
          <div key={f.key} className="space-y-1">
            <label htmlFor={id} className="label-base">{f.label}</label>
            {f.multiline ? (
              <textarea id={id} rows={3} maxLength={max} value={value} placeholder={f.placeholder} onChange={(e) => set(f.key, e.target.value)} className={fieldCls} />
            ) : (
              <input id={id} type="text" maxLength={max} value={value} placeholder={f.placeholder} onChange={(e) => set(f.key, e.target.value)} className={fieldCls} />
            )}
            <div className="flex justify-between gap-3 text-[11px] text-text-muted">
              <span>{f.hint}</span>
              <span className="shrink-0 tabular-nums">{value.length}/{max}</span>
            </div>
          </div>
        )
      })}
    </Card>
  )
}
