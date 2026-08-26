'use client'

/**
 * Campos do destinatário fiscal — Fase Fiscal 6 (PDV comprovante/NFC-e/
 * NF-e). Usado em dois lugares: fechamento do PDV (`vendas/nova/page.tsx`,
 * quando NFC-e/NF-e é escolhido) e "completar dados fiscais" na tela da
 * venda (emissão posterior).
 *
 * Dois modos, propositalmente bem diferentes em exigência (mesma
 * assimetria já modelada em `validateNfeReadiness`/`validateNfceReadiness`
 * — nunca inventada aqui):
 *   'nfce' — só CPF (opcional). NFC-e nunca exige endereço/nome/documento
 *            (auditoria da Fase Fiscal 4: consumidor não identificado é o
 *            caminho feliz mais comum de balcão).
 *   'nfe'  — nome + CPF OU CNPJ + endereço completo. Quando CNPJ é
 *            informado, mostra IE + indicador de IE/contribuinte (nunca
 *            inferido só pela presença de IE — seção 14 do pedido).
 *
 * CEP é resolvido pelo mesmo endpoint já usado por `DeliveryAddressForm`
 * (`/api/shipping/cep`) — nenhuma segunda implementação de lookup.
 */

import { useCallback, useState } from 'react'
import { toast } from 'sonner'
import { Loader2, Receipt } from 'lucide-react'
import { Input } from '@/components/ui/input'

export interface FiscalRecipientValue {
  nome: string | null
  cpf: string | null
  cnpj: string | null
  inscricao_estadual: string | null
  indicador_ie: 1 | 2 | 9 | null
  telefone: string | null
  cep: string | null
  logradouro: string | null
  numero: string | null
  complemento: string | null
  bairro: string | null
  municipio: string | null
  uf: string | null
  municipio_ibge: string | null
  ibge_source: 'viacep' | 'resolve_municipio_ibge' | 'manual_confirmado' | null
}

export const EMPTY_FISCAL_RECIPIENT: FiscalRecipientValue = {
  nome: null, cpf: null, cnpj: null, inscricao_estadual: null, indicador_ie: null,
  telefone: null, cep: null, logradouro: null, numero: null, complemento: null,
  bairro: null, municipio: null, uf: null, municipio_ibge: null, ibge_source: null,
}

const INDICADOR_IE_OPTIONS: { value: 1 | 2 | 9; label: string }[] = [
  { value: 1, label: 'Contribuinte ICMS' },
  { value: 2, label: 'Contribuinte isento de inscrição' },
  { value: 9, label: 'Não contribuinte' },
]

interface Props {
  mode: 'nfce' | 'nfe'
  value: FiscalRecipientValue | null
  onChange: (value: FiscalRecipientValue) => void
}

export function FiscalRecipientFields({ mode, value, onChange }: Props) {
  const [cepLoading, setCepLoading] = useState(false)
  const current = value ?? EMPTY_FISCAL_RECIPIENT

  function patch(fields: Partial<FiscalRecipientValue>) {
    onChange({ ...current, ...fields })
  }

  const lookupCep = useCallback(async (cepRaw: string) => {
    const cep = cepRaw.replace(/\D/g, '')
    if (cep.length !== 8) return
    setCepLoading(true)
    try {
      const res = await fetch(`/api/shipping/cep?cep=${cep}`)
      if (!res.ok) { toast.error('CEP não encontrado'); return }
      const data = await res.json()
      patch({
        cep,
        logradouro: data.street ?? current.logradouro,
        bairro: data.neighborhood ?? current.bairro,
        municipio: data.city ?? current.municipio,
        uf: data.state ?? current.uf,
        municipio_ibge: data.municipio_ibge ?? null,
        ibge_source: data.ibge_source ?? null,
      })
      if (!data.municipio_ibge) {
        toast.warning('Código IBGE não resolvido automaticamente — a NF-e ficará bloqueada até corrigir manualmente.')
      }
    } catch {
      toast.error('Erro ao consultar CEP')
    } finally {
      setCepLoading(false)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [current])

  if (mode === 'nfce') {
    return (
      <div className="space-y-2.5 rounded-xl border border-border bg-bg-overlay p-4">
        <div className="flex items-center gap-2">
          <Receipt className="w-4 h-4 text-text-muted" />
          <p className="text-sm font-semibold text-text-primary">Identificação do consumidor (opcional)</p>
        </div>
        <Input
          label="CPF na nota (opcional)"
          value={current.cpf ?? ''}
          onChange={(e) => patch({ cpf: e.target.value })}
          placeholder="Deixe em branco para não identificar"
        />
      </div>
    )
  }

  const isPj = !!current.cnpj

  return (
    <div className="space-y-2.5 rounded-xl border border-border bg-bg-overlay p-4">
      <div className="flex items-center gap-2">
        <Receipt className="w-4 h-4 text-text-muted" />
        <p className="text-sm font-semibold text-text-primary">Dados fiscais do destinatário (NF-e)</p>
      </div>

      <div className="grid grid-cols-2 gap-2.5">
        <Input label="Nome / Razão social *" value={current.nome ?? ''} onChange={(e) => patch({ nome: e.target.value })} />
        <Input label="Telefone" value={current.telefone ?? ''} onChange={(e) => patch({ telefone: e.target.value })} />
      </div>
      <div className="grid grid-cols-2 gap-2.5">
        <Input label="CPF" value={current.cpf ?? ''} onChange={(e) => patch({ cpf: e.target.value, cnpj: e.target.value ? null : current.cnpj })} />
        <Input label="CNPJ (pessoa jurídica)" value={current.cnpj ?? ''} onChange={(e) => patch({ cnpj: e.target.value, cpf: e.target.value ? null : current.cpf })} />
      </div>

      {isPj && (
        <div className="grid grid-cols-2 gap-2.5">
          <Input label="Inscrição Estadual (se contribuinte)" value={current.inscricao_estadual ?? ''} onChange={(e) => patch({ inscricao_estadual: e.target.value })} />
          <div>
            <label className="text-xs font-medium text-text-secondary block mb-1">Indicador de IE</label>
            <select
              className="w-full rounded-lg border border-border bg-bg-card px-3 py-2 text-sm text-text-primary"
              value={current.indicador_ie ?? ''}
              onChange={(e) => patch({ indicador_ie: e.target.value ? (Number(e.target.value) as 1 | 2 | 9) : null })}
            >
              <option value="">Não informado</option>
              {INDICADOR_IE_OPTIONS.map((opt) => (
                <option key={opt.value} value={opt.value}>{opt.label}</option>
              ))}
            </select>
          </div>
        </div>
      )}

      <div className="grid grid-cols-2 gap-2.5">
        <Input
          label="CEP *"
          value={current.cep ?? ''}
          onChange={(e) => patch({ cep: e.target.value.replace(/\D/g, '').slice(0, 8) })}
          onBlur={(e) => lookupCep(e.target.value)}
          suffix={cepLoading ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : undefined}
          placeholder="00000000"
        />
        <Input label="Número *" value={current.numero ?? ''} onChange={(e) => patch({ numero: e.target.value })} />
      </div>

      <Input label="Logradouro *" value={current.logradouro ?? ''} onChange={(e) => patch({ logradouro: e.target.value })} />
      <Input label="Complemento" value={current.complemento ?? ''} onChange={(e) => patch({ complemento: e.target.value })} />

      <div className="grid grid-cols-3 gap-2.5">
        <div className="col-span-2">
          <Input label="Município *" value={current.municipio ?? ''} onChange={(e) => patch({ municipio: e.target.value })} />
        </div>
        <Input label="UF *" value={current.uf ?? ''} maxLength={2} onChange={(e) => patch({ uf: e.target.value.toUpperCase() })} />
      </div>

      <Input label="Bairro *" value={current.bairro ?? ''} onChange={(e) => patch({ bairro: e.target.value })} />

      {(current.cep?.length ?? 0) === 8 && !current.municipio_ibge && (
        <p className="text-xs text-warning">
          ⚠ Código IBGE não resolvido automaticamente — a venda pode ser concluída, mas a emissão de NF-e ficará bloqueada até isso ser corrigido.
        </p>
      )}
    </div>
  )
}
