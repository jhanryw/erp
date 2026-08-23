'use client'

/**
 * Formulário de endereço de entrega — Fase Fiscal 5C.
 *
 * Mostrado só quando delivery_mode === 'delivery'. Permite escolher um
 * endereço já cadastrado do cliente (customer_addresses, reutilizável) ou
 * cadastrar um novo — em ambos os casos, o valor final vira um SNAPSHOT
 * imutável (sale_recipients) no momento em que a venda é criada, nunca uma
 * referência viva ao cadastro atual do cliente.
 *
 * Código IBGE nunca é digitado — vem da consulta de CEP (ViaCEP, camada 1)
 * com fallback automático no servidor (resolveMunicipioIbge, camada 2).
 */

import { useState, useEffect, useCallback } from 'react'
import { toast } from 'sonner'
import { Loader2, MapPin, Plus } from 'lucide-react'
import { Input } from '@/components/ui/input'

export interface DeliveryRecipientValue {
  nome: string
  cpf?: string | null
  cnpj?: string | null
  telefone?: string | null
  cep: string
  logradouro: string
  numero: string
  complemento?: string | null
  bairro: string
  municipio: string
  uf: string
  municipio_ibge?: string | null
  ibge_source?: 'viacep' | 'resolve_municipio_ibge' | null
  customer_address_id?: number | null
  save_as_customer_address: boolean
}

interface SavedAddress {
  id: number
  cep: string
  street: string
  number: string
  complement: string | null
  neighborhood: string
  city: string
  state: string
  municipio_ibge: string | null
  is_default: boolean
}

interface Props {
  customerId: number | null
  defaultNome: string
  defaultCpf?: string | null
  value: DeliveryRecipientValue | null
  onChange: (value: DeliveryRecipientValue) => void
}

const EMPTY: DeliveryRecipientValue = {
  nome: '', cpf: null, cnpj: null, telefone: null,
  cep: '', logradouro: '', numero: '', complemento: null, bairro: '', municipio: '', uf: '',
  municipio_ibge: null, ibge_source: null, customer_address_id: null, save_as_customer_address: false,
}

export function DeliveryAddressForm({ customerId, defaultNome, defaultCpf, value, onChange }: Props) {
  const [savedAddresses, setSavedAddresses] = useState<SavedAddress[]>([])
  const [loadingAddresses, setLoadingAddresses] = useState(false)
  const [mode, setMode] = useState<'select' | 'new'>('new')
  const [cepLookupLoading, setCepLookupLoading] = useState(false)

  const current = value ?? { ...EMPTY, nome: defaultNome, cpf: defaultCpf ?? null }

  // ── Carrega endereços já cadastrados do cliente ─────────────────────────────
  useEffect(() => {
    if (!customerId) { setSavedAddresses([]); return }
    setLoadingAddresses(true)
    fetch(`/api/clientes/${customerId}/enderecos`)
      .then((r) => (r.ok ? r.json() : { addresses: [] }))
      .then((json) => {
        setSavedAddresses(json.addresses ?? [])
        setMode(json.addresses?.length > 0 ? 'select' : 'new')
      })
      .catch(() => setSavedAddresses([]))
      .finally(() => setLoadingAddresses(false))
  }, [customerId])

  // Reseta o formulário sempre que o CLIENTE muda — um endereço digitado
  // para o cliente anterior nunca deveria sobreviver à troca de cliente.
  useEffect(() => {
    onChange({ ...EMPTY, nome: defaultNome, cpf: defaultCpf ?? null })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [customerId])

  function patch(fields: Partial<DeliveryRecipientValue>) {
    onChange({ ...current, ...fields })
  }

  function selectSavedAddress(addr: SavedAddress) {
    patch({
      customer_address_id: addr.id,
      cep: addr.cep,
      logradouro: addr.street,
      numero: addr.number,
      complemento: addr.complement,
      bairro: addr.neighborhood,
      municipio: addr.city,
      uf: addr.state,
      municipio_ibge: addr.municipio_ibge,
      save_as_customer_address: false,
    })
  }

  const lookupCep = useCallback(async (cepRaw: string) => {
    const cep = cepRaw.replace(/\D/g, '')
    if (cep.length !== 8) return
    setCepLookupLoading(true)
    try {
      const res = await fetch(`/api/shipping/cep?cep=${cep}`)
      if (!res.ok) {
        toast.error('CEP não encontrado')
        return
      }
      const data = await res.json()
      patch({
        cep,
        logradouro: data.street ?? current.logradouro,
        bairro: data.neighborhood ?? current.bairro,
        municipio: data.city ?? current.municipio,
        uf: data.state ?? current.uf,
        municipio_ibge: data.municipio_ibge ?? null,
        ibge_source: data.ibge_source ?? null,
        customer_address_id: null,
      })
      if (!data.municipio_ibge) {
        toast.warning('Código IBGE não resolvido automaticamente — a NF-e ficará bloqueada até corrigir manualmente.')
      }
    } catch {
      toast.error('Erro ao consultar CEP')
    } finally {
      setCepLookupLoading(false)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [current])

  return (
    <div className="space-y-3 rounded-xl border border-border bg-bg-overlay p-4">
      <div className="flex items-center gap-2">
        <MapPin className="w-4 h-4 text-text-muted" />
        <p className="text-sm font-semibold text-text-primary">Endereço de entrega</p>
      </div>

      {loadingAddresses && (
        <p className="text-xs text-text-muted flex items-center gap-1.5">
          <Loader2 className="w-3.5 h-3.5 animate-spin" /> Carregando endereços do cliente…
        </p>
      )}

      {!loadingAddresses && savedAddresses.length > 0 && (
        <div className="space-y-1.5">
          <div className="flex gap-2">
            {(['select', 'new'] as const).map((m) => (
              <button
                key={m}
                type="button"
                onClick={() => setMode(m)}
                className={`flex-1 py-2 rounded-lg border text-xs font-medium transition-colors ${
                  mode === m ? 'bg-brand text-white border-brand' : 'bg-bg-card border-border text-text-secondary'
                }`}
              >
                {m === 'select' ? 'Endereço já cadastrado' : 'Novo endereço'}
              </button>
            ))}
          </div>

          {mode === 'select' && (
            <div className="space-y-1.5">
              {savedAddresses.map((addr) => (
                <button
                  key={addr.id}
                  type="button"
                  onClick={() => selectSavedAddress(addr)}
                  className={`w-full text-left p-3 rounded-lg border text-xs transition-colors ${
                    current.customer_address_id === addr.id
                      ? 'bg-brand/10 border-brand'
                      : 'bg-bg-card border-border hover:border-brand/40'
                  }`}
                >
                  <p className="font-medium text-text-primary">
                    {addr.street}, {addr.number}{addr.complement ? ` — ${addr.complement}` : ''}
                  </p>
                  <p className="text-text-muted">{addr.neighborhood}, {addr.city}/{addr.state} — {addr.cep}</p>
                  {!addr.municipio_ibge && (
                    <p className="text-warning mt-0.5">⚠ Sem código IBGE resolvido</p>
                  )}
                </button>
              ))}
            </div>
          )}
        </div>
      )}

      {mode === 'new' && (
        <div className="space-y-2.5">
          <div className="grid grid-cols-2 gap-2.5">
            <Input label="Nome do destinatário *" value={current.nome} onChange={(e) => patch({ nome: e.target.value })} />
            <Input label="Telefone" value={current.telefone ?? ''} onChange={(e) => patch({ telefone: e.target.value })} />
          </div>
          <div className="grid grid-cols-2 gap-2.5">
            <Input label="CPF" value={current.cpf ?? ''} onChange={(e) => patch({ cpf: e.target.value })} />
            <Input label="CNPJ (se aplicável)" value={current.cnpj ?? ''} onChange={(e) => patch({ cnpj: e.target.value })} />
          </div>

          <div className="grid grid-cols-2 gap-2.5">
            <Input
              label="CEP *"
              value={current.cep}
              onChange={(e) => patch({ cep: e.target.value.replace(/\D/g, '').slice(0, 8) })}
              onBlur={(e) => lookupCep(e.target.value)}
              suffix={cepLookupLoading ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : undefined}
              placeholder="00000000"
            />
            <Input label="Número *" value={current.numero} onChange={(e) => patch({ numero: e.target.value })} />
          </div>

          <Input label="Logradouro *" value={current.logradouro} onChange={(e) => patch({ logradouro: e.target.value })} />
          <Input label="Complemento" value={current.complemento ?? ''} onChange={(e) => patch({ complemento: e.target.value })} />

          <div className="grid grid-cols-3 gap-2.5">
            <div className="col-span-2">
              <Input label="Município *" value={current.municipio} onChange={(e) => patch({ municipio: e.target.value })} />
            </div>
            <Input label="UF *" value={current.uf} maxLength={2} onChange={(e) => patch({ uf: e.target.value.toUpperCase() })} />
          </div>

          <Input label="Bairro *" value={current.bairro} onChange={(e) => patch({ bairro: e.target.value })} />

          {current.cep.length === 8 && !current.municipio_ibge && (
            <p className="text-xs text-warning">
              ⚠ Código IBGE não resolvido automaticamente — a venda pode ser concluída, mas a emissão de NF-e ficará bloqueada até isso ser corrigido.
            </p>
          )}

          <label className="flex items-center gap-2 text-xs text-text-secondary">
            <input
              type="checkbox"
              checked={current.save_as_customer_address ?? false}
              onChange={(e) => patch({ save_as_customer_address: e.target.checked })}
              className="rounded border-border"
            />
            Salvar este endereço no cadastro do cliente para reutilizar depois
          </label>
        </div>
      )}

      {!loadingAddresses && savedAddresses.length === 0 && mode !== 'new' && (
        <button type="button" onClick={() => setMode('new')} className="flex items-center gap-1.5 text-xs text-brand font-medium">
          <Plus className="w-3.5 h-3.5" /> Cadastrar endereço
        </button>
      )}
    </div>
  )
}
