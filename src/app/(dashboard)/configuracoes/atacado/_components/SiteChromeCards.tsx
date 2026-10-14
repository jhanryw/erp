'use client'

import { Card } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { SiteFooter } from '@/app/atacado/_components/SiteFooter'
import { buildWhatsAppContactUrl } from '@/lib/wholesale/whatsapp'
import { resolveStoreInfo } from '@/services/wholesale/storeInfo'
import { formatCnpj, isValidCnpj, safeLinkUrl, type ResolvedSiteChrome } from '@/services/wholesale/siteChrome'
import { LinkListEditor } from './LinkListEditor'

function Check({ label, checked, onChange, hint }: { label: string; checked: boolean; onChange: (v: boolean) => void; hint?: string }) {
  return (
    <label className="flex items-start gap-2.5 py-1 text-sm text-text-primary cursor-pointer">
      <input type="checkbox" className="mt-0.5 h-4 w-4 accent-brand" checked={checked} onChange={(e) => onChange(e.target.checked)} />
      <span>{label}{hint && <span className="block text-xs text-text-muted">{hint}</span>}</span>
    </label>
  )
}

interface ChromeProps {
  chrome: ResolvedSiteChrome
  onChange: (chrome: ResolvedSiteChrome) => void
}

export function FooterCard({ chrome, onChange, displayName, logoUrl, description, whatsappPhone }: ChromeProps & {
  displayName: string | null; logoUrl: string | null; description: string | null; whatsappPhone: string | null
}) {
  const f = chrome.footer
  const s = chrome.store
  const setFooter = (patch: Partial<ResolvedSiteChrome['footer']>) => onChange({ ...chrome, footer: { ...f, ...patch } })
  const setSection = (key: keyof ResolvedSiteChrome['footer']['sections'], v: boolean) => setFooter({ sections: { ...f.sections, [key]: v } })
  const setStore = (patch: Partial<ResolvedSiteChrome['store']>) => onChange({ ...chrome, store: { ...s, ...patch } })

  const cnpjInvalid = s.cnpj.trim() !== '' && !isValidCnpj(s.cnpj)
  const mapsInvalid = s.mapsUrl.trim() !== '' && safeLinkUrl(s.mapsUrl) === null
  const store = resolveStoreInfo({ ...s, cnpj: isValidCnpj(s.cnpj) ? s.cnpj : '', mapsUrl: safeLinkUrl(s.mapsUrl) ?? '' }, null, displayName)

  return (
    <>
      <Card className="p-5 space-y-3">
        <div>
          <h3 className="text-sm font-semibold text-text-primary">Seções do rodapé</h3>
          <p className="text-xs text-text-muted">Seção desligada não aparece. Campos vazios nunca geram bloco vazio.</p>
        </div>
        <div className="grid sm:grid-cols-2 gap-x-6">
          <Check label="Marca (logo e descrição)" checked={f.sections.brand} onChange={(v) => setSection('brand', v)} />
          <Check label="Navegação" checked={f.sections.navigation} onChange={(v) => setSection('navigation', v)} />
          <Check label="Atendimento" checked={f.sections.support} onChange={(v) => setSection('support', v)} />
          <Check label="Nossa loja" checked={f.sections.store} onChange={(v) => setSection('store', v)} />
          <Check label="Rodapé inferior (copyright e links legais)" checked={f.sections.legal} onChange={(v) => setSection('legal', v)} />
        </div>
        <p className="text-xs text-text-muted">A logo vem de <strong>Identidade</strong> (a mesma do cabeçalho) e o WhatsApp de <strong>WhatsApp e redes</strong> (o mesmo do carrinho).</p>
      </Card>

      <Card className="p-5 space-y-4">
        <h3 className="text-sm font-semibold text-text-primary">Links</h3>
        <p className="text-xs text-text-muted">Já existem: Início, Produtos, Categorias e Carrinho. Os links abaixo entram depois deles, na ordem em que estão aqui. Só http(s) ou caminhos do próprio site.</p>
        <LinkListEditor label="Navegação — links adicionais" links={f.navigationLinks} max={8} onChange={(l) => setFooter({ navigationLinks: l })} />
        <LinkListEditor label="Atendimento — páginas institucionais" links={f.supportLinks} max={8} onChange={(l) => setFooter({ supportLinks: l })} />
        <LinkListEditor label="Rodapé inferior — links legais (privacidade, termos…)" links={f.legalLinks} max={6} onChange={(l) => setFooter({ legalLinks: l })} />
        <label className="block space-y-1 text-xs text-text-muted">
          Horário de atendimento (opcional)
          <input className="input-base w-full" maxLength={120} placeholder="Seg a sex, 9h às 18h" value={f.hours} onChange={(e) => setFooter({ hours: e.target.value })} />
        </label>
      </Card>

      <Card className="p-5 space-y-4">
        <div>
          <h3 className="text-sm font-semibold text-text-primary">Informações da loja</h3>
          <p className="text-xs text-text-muted">Nada é inventado: só aparece o que você preencher (ou, se marcar abaixo, o que já está no cadastro fiscal).</p>
        </div>
        <Check
          label="Completar com os dados do cadastro fiscal"
          hint="Razão social, nome fantasia, CNPJ e endereço da Configuração Fiscal, nos campos que ficarem em branco abaixo. Os dados fiscais serão exibidos publicamente."
          checked={s.useFiscalData}
          onChange={(v) => setStore({ useFiscalData: v })}
        />
        <div className="grid sm:grid-cols-2 gap-3">
          <Input label="Nome fantasia" value={s.tradeName} maxLength={120} onChange={(e) => setStore({ tradeName: e.target.value })} />
          <Input label="Razão social" value={s.legalName} maxLength={120} onChange={(e) => setStore({ legalName: e.target.value })} />
          <Input label="CNPJ" value={s.cnpj} maxLength={20} placeholder="00.000.000/0000-00" error={cnpjInvalid ? 'CNPJ inválido.' : undefined}
            onChange={(e) => setStore({ cnpj: e.target.value })} onBlur={() => isValidCnpj(s.cnpj) && setStore({ cnpj: formatCnpj(s.cnpj) })} />
          <Input label="Endereço completo" value={s.addressLine} maxLength={160} onChange={(e) => setStore({ addressLine: e.target.value })} />
          <Input label="Cidade" value={s.city} maxLength={80} onChange={(e) => setStore({ city: e.target.value })} />
          <Input label="Estado (UF)" value={s.state} maxLength={2} placeholder="RN" onChange={(e) => setStore({ state: e.target.value.toUpperCase() })} />
        </div>
        <Input label="Link da localização no Google Maps" value={s.mapsUrl} maxLength={500} placeholder="https://maps.google.com/…"
          error={mapsInvalid ? 'Use um link http(s)://.' : undefined} onChange={(e) => setStore({ mapsUrl: e.target.value })} />
      </Card>

      <Card className="p-5 space-y-3">
        <h3 className="text-sm font-semibold text-text-primary">Prévia do rodapé</h3>
        <div className="overflow-hidden rounded-lg border border-border bg-white">
          <SiteFooter
            basePath="/atacado" companyName={displayName ?? ''} logoUrl={logoUrl}
            description={description ? description.split('\n') : []} chrome={chrome} store={store}
            hasExplicitStoreName={!!(s.tradeName || s.legalName)}
            whatsappUrl={buildWhatsAppContactUrl(whatsappPhone, chrome.whatsappFloat.message)}
            year={new Date().getFullYear()}
          />
        </div>
        <p className="text-xs text-text-muted">Prévia sem os dados do cadastro fiscal (eles são aplicados no site quando a opção está marcada).</p>
      </Card>
    </>
  )
}

export function WhatsAppSocialCard({ chrome, onChange, whatsappPhone, onWhatsappPhoneChange }: ChromeProps & {
  whatsappPhone: string | null; onWhatsappPhoneChange: (value: string) => void
}) {
  const w = chrome.whatsappFloat
  const setFloat = (patch: Partial<ResolvedSiteChrome['whatsappFloat']>) => onChange({ ...chrome, whatsappFloat: { ...w, ...patch } })
  const url = buildWhatsAppContactUrl(whatsappPhone, w.message)
  const igInvalid = chrome.social.instagramUrl.trim() !== '' && safeLinkUrl(chrome.social.instagramUrl) === null

  return (
    <>
      <Card className="p-5 space-y-3">
        <h3 className="text-sm font-semibold text-text-primary">WhatsApp comercial</h3>
        <Input label="Número do WhatsApp da loja" placeholder="84 99999-9999" value={whatsappPhone ?? ''} onChange={(e) => onWhatsappPhoneChange(e.target.value)} />
        <p className="text-xs text-text-muted">
          É <strong>o mesmo número</strong> usado para receber os pedidos do carrinho — não existe um segundo número. Sem número válido, o botão flutuante não aparece.
        </p>
      </Card>

      <Card className="p-5 space-y-3">
        <div>
          <h3 className="text-sm font-semibold text-text-primary">Botão flutuante de atendimento</h3>
          <p className="text-xs text-text-muted">Canto inferior direito. É só atendimento: não substitui o botão “Finalizar pedido pelo WhatsApp” do carrinho. No celular fica oculto no carrinho e nas páginas de produto, para não cobrir os controles de compra.</p>
        </div>
        <Check label="Exibir no desktop" checked={w.enabledDesktop} onChange={(v) => setFloat({ enabledDesktop: v })} />
        <Check label="Exibir no celular" checked={w.enabledMobile} onChange={(v) => setFloat({ enabledMobile: v })} />
        <label className="block space-y-1 text-xs text-text-muted">
          Mensagem inicial do atendimento
          <textarea className="input-base w-full" rows={2} maxLength={300} value={w.message} onChange={(e) => setFloat({ message: e.target.value })} />
        </label>
        <div className="flex flex-wrap items-center gap-3 rounded-lg bg-bg-overlay p-3">
          <span className="flex h-12 w-12 items-center justify-center rounded-full bg-[#25D366] shadow-md" aria-hidden>
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src="/brand/whatsapp/whatsapp-glyph-white.svg" alt="" className="h-7 w-7" />
          </span>
          <div className="min-w-0 text-xs text-text-muted">
            {url
              ? <>Abre a conversa com <strong>{whatsappPhone}</strong> com a mensagem acima. <a className="underline" href={url} target="_blank" rel="noopener noreferrer">Testar</a></>
              : <span className="text-error">WhatsApp não configurado ou inválido — o botão não será exibido.</span>}
          </div>
        </div>
      </Card>

      <Card className="p-5 space-y-3">
        <h3 className="text-sm font-semibold text-text-primary">Redes sociais</h3>
        <Input label="Instagram (link do perfil)" value={chrome.social.instagramUrl} maxLength={500} placeholder="https://instagram.com/sua_loja"
          error={igInvalid ? 'Use um link http(s)://.' : undefined}
          onChange={(e) => onChange({ ...chrome, social: { ...chrome.social, instagramUrl: e.target.value } })} />
      </Card>
    </>
  )
}
