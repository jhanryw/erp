'use client'

import { useEffect, useState } from 'react'
import type { Seller, SellersResponse } from '@/app/api/sellers/route'

interface SellerPickerProps {
  value: number | null
  onChange: (sellerId: number) => void
  /** Called when the user's account has no seller linked (blocks sale creation) */
  onBlockedError?: (msg: string) => void
  /** Validation error message to display below chips */
  error?: string
}

export type { Seller }

export function SellerPicker({ value, onChange, onBlockedError, error }: SellerPickerProps) {
  const [sellers, setSellers] = useState<Seller[]>([])
  const [locked, setLocked] = useState(false)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    fetch('/api/sellers')
      .then((r) => r.json())
      .then((json: SellersResponse) => {
        setSellers(json.sellers)
        setLocked(json.locked)

        if (json.locked && json.my_seller) {
          onChange(json.my_seller.id)
        } else if (json.locked && !json.my_seller) {
          const msg = 'Esta conta não está vinculada a nenhum vendedor. Contate o administrador.'
          setLoadError(msg)
          onBlockedError?.(msg)
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
      <p className="text-xs font-medium text-text-secondary">
        Vendedor responsável *
        {locked && (
          <span className="ml-2 text-[10px] text-text-muted font-normal">
            (vinculado à conta)
          </span>
        )}
      </p>

      <div className="flex flex-wrap gap-2">
        {sellers.map((seller) => {
          const isSelected = value === seller.id
          const isDisabled = locked && value !== seller.id
          return (
            <button
              key={seller.id}
              type="button"
              disabled={isDisabled}
              onClick={() => !isDisabled && onChange(seller.id)}
              className={[
                'px-4 py-2 rounded-full border text-sm font-medium transition-colors',
                isSelected
                  ? 'bg-brand text-white border-brand shadow-sm'
                  : 'bg-bg-overlay text-text-secondary border-border',
                !isDisabled && !isSelected
                  ? 'hover:border-brand/50 hover:text-text-primary cursor-pointer'
                  : '',
                isDisabled ? 'opacity-40 cursor-not-allowed' : '',
              ]
                .filter(Boolean)
                .join(' ')}
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
