'use client'

import { useState, useMemo, useRef, useEffect } from 'react'
import Link from 'next/link'
import { Card, CardHeader } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { formatCurrency } from '@/lib/utils/currency'
import { AlertTriangle, Package, Phone, MapPin } from 'lucide-react'

export type PedidoItem = {
  product_variation_id: number
  product_id: number
  product_name: string
  sku_variation: string
  color: string | null
  size: string | null
  suggested_purchase_qty: number
  estimated_restock_cost: string
  recommended_supplier_id: number | null
  recommended_supplier_name: string | null
  recommended_avg_cost_per_unit: string | null
  urgency: 'critica' | 'alta' | 'media' | 'baixa'
  unit_cost_estimate: string
}

export type SupplierContact = {
  id: number
  phone: string | null
  city: string | null
  state: string | null
}

type SupplierGroup = {
  supplier_id: number | null
  supplier_name: string
  phone: string | null
  city: string | null
  state: string | null
  items: PedidoItem[]
  totalCost: number
}

const URGENCY_ORDER: Record<string, number> = { critica: 0, alta: 1, media: 2, baixa: 3 }
const URGENCY_LABELS: Record<string, string> = {
  critica: 'Crítica', alta: 'Alta', media: 'Média', baixa: 'Baixa',
}
const URGENCY_VARIANTS: Record<string, 'error' | 'warning' | 'info' | 'default'> = {
  critica: 'error', alta: 'warning', media: 'info', baixa: 'default',
}

function sortByUrgency(items: PedidoItem[]): PedidoItem[] {
  return [...items].sort((a, b) =>
    (URGENCY_ORDER[a.urgency] ?? 9) - (URGENCY_ORDER[b.urgency] ?? 9)
  )
}

function GroupCheckbox({
  items,
  excludedIds,
  onToggle,
}: {
  items: PedidoItem[]
  excludedIds: Set<number>
  onToggle: () => void
}) {
  const ref = useRef<HTMLInputElement>(null)
  const ids = items.map(i => i.product_variation_id)
  const excludedCount = ids.filter(id => excludedIds.has(id)).length
  const allExcluded = excludedCount === ids.length
  const someExcluded = excludedCount > 0 && !allExcluded

  useEffect(() => {
    if (ref.current) ref.current.indeterminate = someExcluded
  }, [someExcluded])

  return (
    <input
      ref={ref}
      type="checkbox"
      checked={!allExcluded}
      onChange={onToggle}
      className="w-4 h-4 accent-brand cursor-pointer shrink-0 mt-0.5"
    />
  )
}

export function PedidoCompras({
  items,
  supplierContacts,
}: {
  items: PedidoItem[]
  supplierContacts: Record<number, SupplierContact>
}) {
  const [includedUrgencies, setIncludedUrgencies] = useState<Set<string>>(
    new Set(['critica', 'alta'])
  )
  const [excludedIds, setExcludedIds] = useState<Set<number>>(new Set())

  const toggleItem = (id: number) => {
    setExcludedIds(prev => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id); else next.add(id)
      return next
    })
  }

  const toggleGroup = (group: SupplierGroup) => {
    const ids = group.items.map(i => i.product_variation_id)
    const someExcluded = ids.some(id => excludedIds.has(id))
    setExcludedIds(prev => {
      const next = new Set(prev)
      if (someExcluded) ids.forEach(id => next.delete(id))
      else ids.forEach(id => next.add(id))
      return next
    })
  }

  const toggleUrgency = (u: string) => {
    setIncludedUrgencies(prev => {
      const next = new Set(prev)
      if (next.has(u)) { if (next.size > 1) next.delete(u) }
      else next.add(u)
      return next
    })
  }

  const { namedGroups, nullGroup, grandTotal, activeItemCount } = useMemo(() => {
    const filtered = items.filter(i => includedUrgencies.has(i.urgency))

    const map = new Map<number | null, PedidoItem[]>()
    for (const item of filtered) {
      const key = item.recommended_supplier_id ?? null
      if (!map.has(key)) map.set(key, [])
      map.get(key)!.push(item)
    }

    const namedGroups: SupplierGroup[] = []
    let nullGroup: SupplierGroup | null = null

    for (const [supplier_id, groupItems] of map.entries()) {
      const contact = supplier_id !== null ? supplierContacts[supplier_id] : undefined
      const sorted = sortByUrgency(groupItems)
      const totalCost = groupItems.reduce((s, i) => s + parseFloat(i.estimated_restock_cost), 0)
      const group: SupplierGroup = {
        supplier_id,
        supplier_name: supplier_id !== null
          ? (groupItems[0].recommended_supplier_name ?? 'Fornecedor')
          : 'Sem fornecedor definido',
        phone:  contact?.phone  ?? null,
        city:   contact?.city   ?? null,
        state:  contact?.state  ?? null,
        items:  sorted,
        totalCost,
      }
      if (supplier_id === null) nullGroup = group
      else namedGroups.push(group)
    }

    namedGroups.sort((a, b) => b.totalCost - a.totalCost)

    const grandTotal = namedGroups
      .flatMap(g => g.items)
      .filter(i => !excludedIds.has(i.product_variation_id))
      .reduce((s, i) => s + parseFloat(i.estimated_restock_cost), 0)

    const activeItemCount = namedGroups
      .flatMap(g => g.items)
      .filter(i => !excludedIds.has(i.product_variation_id))
      .length

    return { namedGroups, nullGroup, grandTotal, activeItemCount }
  }, [items, includedUrgencies, excludedIds, supplierContacts])

  const urgencies = ['critica', 'alta', 'media', 'baixa'] as const

  const urgencyFilterColor: Record<string, string> = {
    critica: 'bg-error/15 border-error/50 text-error',
    alta:    'bg-warning/15 border-warning/50 text-warning',
    media:   'bg-info/15 border-info/50 text-info',
    baixa:   'bg-brand/15 border-brand/50 text-brand',
  }

  return (
    <div className="space-y-5 pb-6">
      {/* Aviso */}
      <div className="flex items-start gap-2 p-3 rounded-lg bg-warning/8 border border-warning/20 text-xs text-warning">
        <AlertTriangle className="w-3.5 h-3.5 mt-0.5 shrink-0" />
        <span>
          Este é um rascunho de compra sugerida. Ele{' '}
          <strong>não cria pedido real</strong>, não altera estoque e não envia
          nada ao fornecedor.
        </span>
      </div>

      {/* Filtros + resumo */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-1.5 flex-wrap">
          <span className="text-xs text-text-muted">Urgência:</span>
          {urgencies.map(u => {
            const active = includedUrgencies.has(u)
            return (
              <button
                key={u}
                onClick={() => toggleUrgency(u)}
                className={`text-xs px-2.5 py-1 rounded-full border transition-colors font-medium ${
                  active
                    ? urgencyFilterColor[u]
                    : 'bg-transparent border-border text-text-muted hover:border-text-muted'
                }`}
              >
                {URGENCY_LABELS[u]}
              </button>
            )
          })}
        </div>
        <div className="flex items-center gap-3 text-xs text-text-muted">
          <span>
            <strong className="text-text-primary">{namedGroups.length}</strong> fornecedores
          </span>
          <span>
            <strong className="text-text-primary">{activeItemCount}</strong> itens
          </span>
          <span className="text-sm font-semibold text-text-primary">
            {formatCurrency(grandTotal)}
          </span>
        </div>
      </div>

      {/* Grupos */}
      {namedGroups.length === 0 && !nullGroup ? (
        <div className="p-16 text-center space-y-2">
          <p className="text-3xl">📦</p>
          <p className="text-sm font-semibold text-text-primary">
            Nenhum item com essa urgência para pedir.
          </p>
          <p className="text-xs text-text-muted">Ajuste os filtros de urgência acima.</p>
        </div>
      ) : (
        <div className="space-y-4">
          {namedGroups.map(group => {
            const subtotal = group.items
              .filter(i => !excludedIds.has(i.product_variation_id))
              .reduce((s, i) => s + parseFloat(i.estimated_restock_cost), 0)
            const activeCount = group.items.filter(
              i => !excludedIds.has(i.product_variation_id)
            ).length

            return (
              <Card key={group.supplier_id}>
                <CardHeader>
                  <div className="flex items-start justify-between gap-4">
                    <div className="flex items-start gap-3">
                      <GroupCheckbox
                        items={group.items}
                        excludedIds={excludedIds}
                        onToggle={() => toggleGroup(group)}
                      />
                      <div>
                        <h3 className="text-sm font-semibold text-text-primary">
                          {group.supplier_name}
                        </h3>
                        <div className="flex flex-wrap items-center gap-x-3 gap-y-0.5 mt-0.5">
                          {group.phone && (
                            <span className="flex items-center gap-1 text-xs text-text-muted">
                              <Phone className="w-3 h-3" />{group.phone}
                            </span>
                          )}
                          {group.city && (
                            <span className="flex items-center gap-1 text-xs text-text-muted">
                              <MapPin className="w-3 h-3" />
                              {group.city}{group.state ? `, ${group.state}` : ''}
                            </span>
                          )}
                        </div>
                      </div>
                    </div>
                    <div className="text-right shrink-0">
                      <p className="text-sm font-semibold text-text-primary">
                        {formatCurrency(subtotal)}
                      </p>
                      <p className="text-xs text-text-muted">
                        {activeCount} de {group.items.length} itens
                      </p>
                    </div>
                  </div>
                </CardHeader>

                <div className="overflow-x-auto">
                  <table className="w-full text-sm">
                    <thead>
                      <tr className="border-b border-border">
                        <th className="w-10 px-4 py-2.5" />
                        <th className="text-left px-3 py-2.5 text-xs font-medium text-text-muted">
                          Produto / Variação
                        </th>
                        <th className="text-right px-3 py-2.5 text-xs font-medium text-text-muted">
                          Urgência
                        </th>
                        <th className="text-right px-3 py-2.5 text-xs font-medium text-text-muted">
                          Qtd sugerida
                        </th>
                        <th className="text-right px-3 py-2.5 text-xs font-medium text-text-muted">
                          Custo/un
                        </th>
                        <th className="text-right px-4 py-2.5 text-xs font-medium text-text-muted">
                          Total
                        </th>
                      </tr>
                    </thead>
                    <tbody>
                      {group.items.map(item => {
                        const excluded = excludedIds.has(item.product_variation_id)
                        return (
                          <tr
                            key={item.product_variation_id}
                            className={`border-b border-border/50 transition-opacity ${
                              excluded ? 'opacity-40' : ''
                            }`}
                          >
                            <td className="px-4 py-2.5">
                              <input
                                type="checkbox"
                                checked={!excluded}
                                onChange={() => toggleItem(item.product_variation_id)}
                                className="w-4 h-4 accent-brand cursor-pointer"
                              />
                            </td>
                            <td className="px-3 py-2.5">
                              <Link
                                href={`/produtos/${item.product_id}`}
                                className="hover:underline"
                              >
                                <span className="text-text-primary font-medium block leading-tight">
                                  {item.product_name}
                                </span>
                              </Link>
                              <span className="text-xs text-text-muted">
                                {item.sku_variation}
                                {item.color && ` · ${item.color}`}
                                {item.size && ` · ${item.size}`}
                              </span>
                            </td>
                            <td className="px-3 py-2.5 text-right">
                              <Badge
                                variant={URGENCY_VARIANTS[item.urgency] ?? 'default'}
                                size="sm"
                              >
                                {URGENCY_LABELS[item.urgency] ?? item.urgency}
                              </Badge>
                            </td>
                            <td className="px-3 py-2.5 text-right font-semibold text-brand">
                              {item.suggested_purchase_qty}
                            </td>
                            <td className="px-3 py-2.5 text-right text-xs text-text-muted">
                              {item.recommended_avg_cost_per_unit
                                ? formatCurrency(parseFloat(item.recommended_avg_cost_per_unit))
                                : formatCurrency(parseFloat(item.unit_cost_estimate))}
                            </td>
                            <td className="px-4 py-2.5 text-right font-medium text-text-primary">
                              {formatCurrency(parseFloat(item.estimated_restock_cost))}
                            </td>
                          </tr>
                        )
                      })}
                    </tbody>
                    <tfoot>
                      <tr className="border-t border-border bg-bg-surface/50">
                        <td
                          colSpan={5}
                          className="px-4 py-2.5 text-xs text-text-muted text-right"
                        >
                          Subtotal {group.supplier_name}
                        </td>
                        <td className="px-4 py-2.5 text-right font-semibold text-text-primary">
                          {formatCurrency(subtotal)}
                        </td>
                      </tr>
                    </tfoot>
                  </table>
                </div>
              </Card>
            )
          })}

          {/* Grupo sem fornecedor */}
          {nullGroup && (
            <Card>
              <CardHeader>
                <div className="flex items-center gap-2">
                  <Package className="w-4 h-4 text-text-muted" />
                  <h3 className="text-sm font-semibold text-text-muted">
                    {nullGroup.supplier_name}
                  </h3>
                  <span className="text-xs text-text-muted">
                    ({nullGroup.items.length} itens)
                  </span>
                </div>
                <p className="text-xs text-text-muted mt-1 flex items-center gap-1">
                  <AlertTriangle className="w-3 h-3" />
                  Sem fornecedor cadastrado nos últimos 180 dias. Não entram no total do pedido.
                </p>
              </CardHeader>
              <div className="overflow-x-auto">
                <table className="w-full text-sm opacity-60">
                  <tbody>
                    {nullGroup.items.map(item => (
                      <tr
                        key={item.product_variation_id}
                        className="border-b border-border/50"
                      >
                        <td className="px-4 py-2.5">
                          <Link
                            href={`/produtos/${item.product_id}`}
                            className="hover:underline"
                          >
                            <span className="text-text-primary font-medium block leading-tight">
                              {item.product_name}
                            </span>
                          </Link>
                          <span className="text-xs text-text-muted">
                            {item.sku_variation}
                            {item.color && ` · ${item.color}`}
                            {item.size && ` · ${item.size}`}
                          </span>
                        </td>
                        <td className="px-3 py-2.5 text-right">
                          <Badge
                            variant={URGENCY_VARIANTS[item.urgency] ?? 'default'}
                            size="sm"
                          >
                            {URGENCY_LABELS[item.urgency] ?? item.urgency}
                          </Badge>
                        </td>
                        <td className="px-3 py-2.5 text-right text-text-muted">
                          {item.suggested_purchase_qty} un
                        </td>
                        <td className="px-4 py-2.5 text-right text-text-muted">
                          {formatCurrency(parseFloat(item.estimated_restock_cost))}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </Card>
          )}
        </div>
      )}

      {/* Total + botão */}
      <Card>
        <div className="p-5 flex flex-col sm:flex-row items-center justify-between gap-4">
          <div>
            <p className="text-xs text-text-muted mb-0.5">
              Total estimado do pedido
            </p>
            <p className="text-2xl font-bold text-text-primary">
              {formatCurrency(grandTotal)}
            </p>
            <p className="text-xs text-text-muted mt-0.5">
              {activeItemCount} itens selecionados · {namedGroups.length} fornecedores
            </p>
          </div>
          <button
            disabled
            title="Funcionalidade em desenvolvimento"
            className="w-full sm:w-auto px-5 py-2.5 rounded-lg bg-brand/20 text-brand text-sm font-semibold cursor-not-allowed opacity-50 whitespace-nowrap"
          >
            Gerar pedido — em breve
          </button>
        </div>
      </Card>
    </div>
  )
}
