'use client'

import { useEffect, useState } from 'react'
import type { Seller, SellersResponse } from '@/app/api/sellers/route'
import { pickDefaultSeller } from '@/lib/sales/pickDefaultSeller'

interface SellerPickerProps {
  value: number | null
  onChange: (sellerId: number) => void
  /** Called when the user's account has no seller linked (blocks sale creation) */
  onBlockedError?: (msg: string) => void
  /** Called with the locked state after seller data loads */
  onLockedChange?: (locked: boolean) => void
  /** Validation error message to display below chips */
  error?: string
}

export type { Seller }

export function SellerPicker({ value, onChange, onBlockedError, onLockedChange, error }: SellerPickerProps) {
  const [sellers, setSellers] = useState<Seller[]>([])
  const [loadError, setLoadError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    fetch('/api/sellers')
      .then((r) => r.json())
      .then((json: SellersResponse) => {
        setSellers(json.sellers)
        onLockedChange?.(json.locked)
        const defaultSellerId = pickDefaultSeller(json.sellers, value)
        if (defaultSellerId != null && defaultSellerId !== value) {
          onChange(defaultSellerId)
        }
      })
      .catch(() => {
        const msg = 'Erro ao carregar vendedores.'
        setLoadError(msg)
        onBlockedError?.(msg)
      })
      .finally(() => setLoading(false))
  // onChange/onBlockedError are stable refs, safe to omit
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  if (loading) {
    return (
      <div className="space-y-1.5">
        <p className="text-xs font-medium text-text-secondary">Vendedor responsável *</p>
        <div className="h-11 rounded-lg bg-bg-overlay animate-pulse" />
      </div>
    )
  }

  if (loadError) return null

  return (
    <div className="space-y-1.5">
      <p className="text-xs font-medium text-text-secondary">Vendedor responsável *</p>

      <div className="flex flex-wrap gap-2">
        {/* Qualquer vendedor ativo da empresa pode ser selecionado, por
            qualquer role — Vendas/PDV não é módulo bloqueado. Autorização
            real (tenant + ativo) é feita server-side em POST /api/vendas. */}
        {sellers.map((seller) => {
          const isSelected = value === seller.id
          return (
            <button
              key={seller.id}
              type="button"
              onClick={() => onChange(seller.id)}
              className={[
                'px-4 py-2 rounded-full border text-sm font-medium transition-colors cursor-pointer',
                isSelected
                  ? 'bg-brand text-white border-brand shadow-sm'
                  : 'bg-bg-overlay text-text-secondary border-border hover:border-brand/50 hover:text-text-primary',
              ].join(' ')}
            >
              {seller.name}
            </button>
          )
        })}
      </div>

      {error && (
        <p className="text-xs text-error mt-1">{error}</p>
      )}
    </div>
  )
}
