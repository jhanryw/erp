# Guia de Integração do Módulo de Frete no Checkout

## Visão Geral

Este guia mostra como integrar o cálculo automático de frete no fluxo de checkout.

## 1. Componente de CEP com Busca Automática

```typescript
// components/checkout/CEPInput.tsx
'use client'

import { useState } from 'react'
import { fetchCEP } from '@/lib/services/cepService'

interface CEPInputProps {
  onSuccess: (data: {
    cep: string
    street: string
    neighborhood: string
    city: string
    state: string
    latitude?: number
    longitude?: number
  }) => void
  onError: (error: string) => void
}

export function CEPInput({ onSuccess, onError }: CEPInputProps) {
  const [cep, setCep] = useState('')
  const [loading, setLoading] = useState(false)

  const handleSearch = async (e: React.FormEvent) => {
    e.preventDefault()
    setLoading(true)

    try {
      const response = await fetch('/api/shipping/cep', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ cep })
      })

      if (!response.ok) {
        throw new Error('CEP não encontrado')
      }

      const data = await response.json()
      onSuccess(data)
    } catch (err) {
      onError(err instanceof Error ? err.message : 'Erro ao buscar CEP')
    } finally {
      setLoading(false)
    }
  }

  return (
    <form onSubmit={handleSearch} className="flex gap-2">
      <input
        type="text"
        placeholder="Digite seu CEP"
        value={cep}
        onChange={(e) => setCep(e.target.value.replace(/\D/g, '').slice(0, 8))}
        disabled={loading}
        className="flex-1 px-3 py-2 border rounded"
      />
      <button
        type="submit"
        disabled={loading || cep.length < 8}
        className="px-4 py-2 bg-blue-500 text-white rounded disabled:opacity-50"
      >
        {loading ? 'Buscando...' : 'Buscar'}
      </button>
    </form>
  )
}
```

## 2. Componente de Cálculo de Frete

```typescript
// components/checkout/ShippingCalculator.tsx
'use client'

import { useState, useEffect } from 'react'
import type { ShippingCalculationResult } from '@/types/shipping.types'

interface ShippingCalculatorProps {
  cartTotal: number
  onShippingUpdate: (shipping: ShippingCalculationResult | null) => void
}

interface CEPData {
  latitude?: number
  longitude?: number
  cep: string
  city: string
  neighborhood: string
}

export function ShippingCalculator({ cartTotal, onShippingUpdate }: ShippingCalculatorProps) {
  const [cepData, setCEPData] = useState<CEPData | null>(null)
  const [shipping, setShipping] = useState<ShippingCalculationResult | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)

  // Recalcular frete quando o carrinho mudar
  useEffect(() => {
    if (cepData && cepData.latitude && cepData.longitude) {
      calculateShipping(cepData)
    }
  }, [cartTotal])

  const calculateShipping = async (data: CEPData) => {
    if (!data.latitude || !data.longitude) return

    setLoading(true)
    try {
      const response = await fetch('/api/shipping/calculate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          latitude: data.latitude,
          longitude: data.longitude,
          cep: data.cep,
          city: data.city,
          neighborhood: data.neighborhood,
          order_total: cartTotal
        })
      })

      const result = await response.json()

      if ('error' in result) {
        setError(result.error)
        setShipping(null)
        onShippingUpdate(null)
      } else {
        setError(null)
        setShipping(result)
        onShippingUpdate(result)
      }
    } catch (err) {
      setError('Erro ao calcular frete')
      onShippingUpdate(null)
    } finally {
      setLoading(false)
    }
  }

  const handleCEPSuccess = async (data: CEPData) => {
    setCEPData(data)
    await calculateShipping(data)
  }

  return (
    <div className="space-y-4">
      <CEPInput
        onSuccess={handleCEPSuccess}
        onError={(err) => setError(err)}
      />

      {error && (
        <div className="p-3 bg-red-100 text-red-700 rounded">
          {error}
        </div>
      )}

      {cepData && (
        <div className="p-3 bg-blue-50 border border-blue-200 rounded">
          <p className="text-sm text-gray-600">
            {cepData.street}, {cepData.neighborhood}
            <br />
            {cepData.city} / {cepData.state}
          </p>
        </div>
      )}

      {shipping && (
        <div className="p-3 bg-green-50 border border-green-200 rounded">
          <div className="flex justify-between items-center">
            <div>
              <p className="font-semibold text-gray-800">Frete</p>
              <p className="text-sm text-gray-600">{shipping.reason}</p>
              {shipping.free_shipping_applied && (
                <p className="text-sm text-green-600 font-semibold">
                  ✓ Frete Grátis
                </p>
              )}
            </div>
            <div className="text-right">
              <p className="text-2xl font-bold text-green-600">
                R$ {shipping.client_price.toFixed(2)}
              </p>
              <p className="text-xs text-gray-500">
                {shipping.distance_km}km | {shipping.estimated_hours}h
              </p>
            </div>
          </div>
        </div>
      )}

      {loading && (
        <div className="text-center text-gray-500">
          Calculando frete...
        </div>
      )}
    </div>
  )
}
```

## 3. Integração no Checkout

```typescript
// app/checkout/page.tsx
'use client'

import { useState } from 'react'
import { ShippingCalculator } from '@/components/checkout/ShippingCalculator'
import type { ShippingCalculationResult } from '@/types/shipping.types'

export default function CheckoutPage() {
  const [cartTotal, setCartTotal] = useState(500) // Exemplo
  const [shipping, setShipping] = useState<ShippingCalculationResult | null>(null)

  const finalTotal = cartTotal + (shipping?.client_price || 0)

  return (
    <div className="max-w-2xl mx-auto p-6">
      <h1 className="text-2xl font-bold mb-6">Checkout</h1>

      <div className="space-y-6">
        {/* Carrinho */}
        <div className="border rounded p-4">
          <h2 className="font-semibold mb-4">Seu Carrinho</h2>
          <div className="flex justify-between pb-2 border-b">
            <span>Subtotal</span>
            <span>R$ {cartTotal.toFixed(2)}</span>
          </div>
        </div>

        {/* Cálculo de Frete */}
        <div className="border rounded p-4">
          <h2 className="font-semibold mb-4">Entrega</h2>
          <ShippingCalculator
            cartTotal={cartTotal}
            onShippingUpdate={setShipping}
          />
        </div>

        {/* Resumo do Pedido */}
        <div className="border rounded p-4 bg-gray-50">
          <h2 className="font-semibold mb-4">Resumo do Pedido</h2>
          <div className="space-y-2 text-sm">
            <div className="flex justify-between">
              <span>Subtotal</span>
              <span>R$ {cartTotal.toFixed(2)}</span>
            </div>
            {shipping && (
              <div className="flex justify-between">
                <span>Frete</span>
                <span>
                  {shipping.free_shipping_applied ? (
                    <span className="text-green-600">Grátis</span>
                  ) : (
                    `R$ ${shipping.client_price.toFixed(2)}`
                  )}
                </span>
              </div>
            )}
            <div className="flex justify-between font-bold text-lg border-t pt-2">
              <span>Total</span>
              <span>R$ {finalTotal.toFixed(2)}</span>
            </div>
          </div>
        </div>

        {/* Botão de Finalizar */}
        <button
          disabled={!shipping}
          className="w-full py-3 bg-green-600 text-white rounded font-semibold disabled:opacity-50"
        >
          Finalizar Compra
        </button>
      </div>
    </div>
  )
}
```

## 4. Salvando o Pedido com Dados de Frete

```typescript
// app/api/checkout/create-order/route.ts
export const dynamic = 'force-dynamic'

import { NextResponse } from 'next/server'
import { createAdminClient } from '@/lib/supabase/admin'
import { z } from 'zod'

const schema = z.object({
  customer_id: z.number(),
  address_id: z.number(),
  total_amount: z.number(),
  items: z.array(z.object({
    product_id: z.number(),
    quantity: z.number(),
    unit_price: z.number()
  })),
  shipping: z.object({
    zone_id: z.number(),
    rule_id: z.number(),
    distance_km: z.number(),
    client_price: z.number(),
    internal_cost: z.number(),
    subsidy: z.number()
  })
})

export async function POST(request: Request) {
  try {
    const body = await request.json()
    const parsed = schema.safeParse(body)

    if (!parsed.success) {
      return NextResponse.json({ error: parsed.error.flatten() }, { status: 422 })
    }

    const admin = createAdminClient()

    // 1. Criar pedido (sales)
    const { data: sale, error: saleError } = await admin
      .from('sales')
      .insert({
        customer_id: parsed.data.customer_id,
        seller_id: '00000000-0000-0000-0000-000000000000', // substituir
        total_amount: parsed.data.total_amount,
        payment_method: 'pix', // substituir
        status: 'pending'
      })
      .select()
      .single()

    if (saleError) throw saleError

    // 2. Inserir itens do pedido
    const { error: itemsError } = await admin.from('sale_items').insert(
      parsed.data.items.map((item) => ({
        sale_id: sale.id,
        product_id: item.product_id,
        quantity: item.quantity,
        unit_price: item.unit_price
      }))
    )

    if (itemsError) throw itemsError

    // 3. Criar shipment com dados de frete
    const { data: shipment, error: shipmentError } = await admin
      .from('shipments')
      .insert({
        order_id: sale.id,
        customer_id: parsed.data.customer_id,
        address_id: parsed.data.address_id,
        origin_id: 1, // Santtorini
        zone_id: parsed.data.shipping.zone_id,
        rule_id: parsed.data.shipping.rule_id,
        delivery_mode: 'delivery',
        distance_km: parsed.data.shipping.distance_km,
        client_shipping_price: parsed.data.shipping.client_price,
        internal_shipping_cost_estimated: parsed.data.shipping.internal_cost,
        shipping_subsidy: parsed.data.shipping.subsidy,
        status: 'aguardando_confirmacao'
      })
      .select()
      .single()

    if (shipmentError) throw shipmentError

    // 4. Criar evento inicial de rastreamento
    await admin.from('shipment_events').insert({
      shipment_id: shipment.id,
      status: 'aguardando_confirmacao',
      description: 'Pedido confirmado e aguardando separação'
    })

    return NextResponse.json({ sale, shipment }, { status: 201 })
  } catch (error) {
    console.error('[API Create Order]', error)
    return NextResponse.json({ error: 'Erro ao criar pedido' }, { status: 500 })
  }
}
```

## 5. Hook Customizado para Gerenciar Frete

```typescript
// hooks/useShipping.ts
import { useState, useCallback } from 'react'
import type { ShippingCalculationResult } from '@/types/shipping.types'

export function useShipping() {
  const [shipping, setShipping] = useState<ShippingCalculationResult | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const calculateShipping = useCallback(
    async (
      latitude: number,
      longitude: number,
      cep: string,
      city: string,
      neighborhood: string,
      orderTotal: number
    ) => {
      setLoading(true)
      setError(null)

      try {
        const response = await fetch('/api/shipping/calculate', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            latitude,
            longitude,
            cep,
            city,
            neighborhood,
            order_total: orderTotal
          })
        })

        const data = await response.json()

        if ('error' in data) {
          setError(data.error)
          setShipping(null)
        } else {
          setShipping(data)
        }

        return data
      } catch (err) {
        const message = err instanceof Error ? err.message : 'Erro desconhecido'
        setError(message)
        setShipping(null)
      } finally {
        setLoading(false)
      }
    },
    []
  )

  const reset = useCallback(() => {
    setShipping(null)
    setError(null)
    setLoading(false)
  }, [])

  return {
    shipping,
    loading,
    error,
    calculateShipping,
    reset
  }
}
```

## 6. Uso do Hook em um Componente

```typescript
// components/checkout/ShippingForm.tsx
'use client'

import { useShipping } from '@/hooks/useShipping'
import { CEPInput } from './CEPInput'

export function ShippingForm({ cartTotal }: { cartTotal: number }) {
  const { shipping, loading, error, calculateShipping } = useShipping()

  const handleCEPSuccess = async (data: {
    latitude?: number
    longitude?: number
    cep: string
    city: string
    neighborhood: string
  }) => {
    if (data.latitude && data.longitude) {
      await calculateShipping(
        data.latitude,
        data.longitude,
        data.cep,
        data.city,
        data.neighborhood,
        cartTotal
      )
    }
  }

  return (
    <div className="space-y-4">
      <CEPInput onSuccess={handleCEPSuccess} onError={console.error} />

      {error && <div className="p-3 bg-red-100 text-red-700 rounded">{error}</div>}

      {loading && <div className="text-center text-gray-500">Calculando...</div>}

      {shipping && (
        <div className="p-3 bg-green-50 border border-green-200 rounded">
          <div className="flex justify-between">
            <div>
              <p className="font-semibold">{shipping.reason}</p>
              {shipping.free_shipping_applied && (
                <p className="text-green-600">Frete Grátis!</p>
              )}
            </div>
            <p className="text-2xl font-bold">
              R$ {shipping.client_price.toFixed(2)}
            </p>
          </div>
        </div>
      )}
    </div>
  )
}
```

## 7. Exemplo de Requisição cURL

```bash
# 1. Buscar dados do CEP
curl -X POST http://localhost:3000/api/shipping/cep \
  -H "Content-Type: application/json" \
  -d '{"cep": "59066400"}'

# Resposta esperada:
# {
#   "cep": "59066400",
#   "street": "Rua Candelária",
#   "neighborhood": "Candelária",
#   "city": "Natal",
#   "state": "RN",
#   "latitude": -5.7942,
#   "longitude": -35.2080
# }

# 2. Calcular frete
curl -X POST http://localhost:3000/api/shipping/calculate \
  -H "Content-Type: application/json" \
  -d '{
    "latitude": -5.7942,
    "longitude": -35.2080,
    "cep": "59066400",
    "city": "Natal",
    "neighborhood": "Candelária",
    "order_total": 150
  }'

# Resposta esperada:
# {
#   "delivery_mode": "delivery",
#   "zone_id": 1,
#   "rule_id": 1,
#   "distance_km": 0.0,
#   "client_price": 10.0,
#   "internal_cost": 15.0,
#   "estimated_hours": 24,
#   "subsidy": 5.0,
#   "free_shipping_applied": false,
#   "reason": "Zona: Natal Central | 0km"
# }

# 3. Criar pedido com frete
curl -X POST http://localhost:3000/api/checkout/create-order \
  -H "Content-Type: application/json" \
  -d '{
    "customer_id": 1,
    "address_id": 1,
    "total_amount": 160,
    "items": [
      {
        "product_id": 1,
        "quantity": 2,
        "unit_price": 75
      }
    ],
    "shipping": {
      "zone_id": 1,
      "rule_id": 1,
      "distance_km": 0,
      "client_price": 10,
      "internal_cost": 15,
      "subsidy": 5
    }
  }'
```

## Fluxo Resumido

1. **Cliente digita CEP** → Componente CEPInput
2. **POST /api/shipping/cep** → Busca dados (ViaCEP + Geocoding)
3. **POST /api/shipping/calculate** → Calcula frete automático
4. **Exibe frete na UI** → ShippingCalculator mostra preço
5. **Finaliza compra** → Cria sale + shipment + shipment_event
6. **Rastreamento** → Cliente acompanha pelo status do shipment

---

**Próxima etapa:** Implementar páginas admin de gerenciamento de zonas e regras.
