'use client'

import { useEffect, useState } from 'react'
import type { Seller, SellersResponse } from '@/app/api/sellers/route'

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
  const [mySellerId, setMySellerId] = useState<number | null>(null)
  const [locked, setLocked] = useState(false)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    fetch('/api/sellers')
      .then((r) => r.json())
      .then((json: SellersResponse) => {
        setSellers(json.sellers)
        setMySellerId(json.my_seller?.id ?? null)
        setLocked(json.locked)
        onLockedChange?.(json.locked)
        // Pre-select the linked seller as a default suggestion
        // (when locked, this is the only option that can actually be chosen)
        if (!value && json.my_seller) {
          onChange(json.my_seller.id)
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
        {sellers.map((seller) => {
          const isSelected = value === seller.id
          // Vendedora (usuario) só pode registrar a venda em seu próprio nome
          // — reforçado no servidor (POST /api/vendas). Aqui é só a UI
          // refletindo essa trava para não sugerir uma ação que será rejeitada.
          const isDisabled = locked && seller.id !== mySellerId
          return (
            <button
              key={seller.id}
              type="button"
              disabled={isDisabled}
              onClick={() => !isDisabled && onChange(seller.id)}
              className={[
                'px-4 py-2 rounded-full border text-sm font-medium transition-colors',
                isDisabled
                  ? 'cursor-not-allowed opacity-40 bg-bg-overlay text-text-secondary border-border'
                  : 'cursor-pointer',
                !isDisabled && isSelected
                  ? 'bg-brand text-white border-brand shadow-sm'
                  : '',
                !isDisabled && !isSelected
                  ? 'bg-bg-overlay text-text-secondary border-border hover:border-brand/50 hover:text-text-primary'
                  : '',
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
