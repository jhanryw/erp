'use client'

import { useState } from 'react'
import Link from 'next/link'
import Image from 'next/image'
import { useRouter } from 'next/navigation'
import { toast } from 'sonner'
import { Package } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Card, CardHeader } from '@/components/ui/card'
import { Table, TableHeader, TableBody, TableRow, TableHead, TableCell } from '@/components/ui/table'
import { formatCurrency, formatPercent } from '@/lib/utils/currency'
import { WHOLESALE_STATUS_LABEL } from '@/services/wholesale/adminStatusLabels'
import type { WholesaleAdminStatus } from '@/services/wholesale/adminStatus'
import { DeleteProductButton } from './delete-product-button'

export interface ProductTableRow {
  id: number
  name: string
  sku: string
  category: string | null
  supplier: string | null
  brand: string | null
  base_cost: number
  base_price: number
  margin_pct: number
  active: boolean
  displayUrl: string | null
  wholesaleStatus: WholesaleAdminStatus
  hasImage: boolean
  /** Produto composto — sem estoque próprio. */
  isKit?: boolean
}

type BulkChanges = { wholesale_enabled?: boolean; wholesale_price_percent?: number }

export function ProductsTable({ rows, total }: { rows: ProductTableRow[]; total: number }) {
  const router = useRouter()
  const [selected, setSelected] = useState<Set<number>>(new Set())
  const [busy, setBusy] = useState(false)
  const [pricing, setPricing] = useState(false)
  const [percent, setPercent] = useState('70')

  const allSelected = rows.length > 0 && rows.every((r) => selected.has(r.id))

  function toggle(id: number) {
    setSelected((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }
  function toggleAll() {
    setSelected(allSelected ? new Set() : new Set(rows.map((r) => r.id)))
  }

  async function run(changes: BulkChanges, confirmMessage: string, successMessage: (n: number) => string) {
    if (selected.size === 0) return
    if (!window.confirm(confirmMessage)) return

    setBusy(true)
    try {
      const res = await fetch('/api/produtos/bulk', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ product_ids: Array.from(selected), changes }),
      })
      const json = await res.json().catch(() => ({}))
      if (!res.ok) {
        toast.error('Não foi possível concluir a ação', { description: json.error ?? 'Falha inesperada.' })
        return
      }
      toast.success(successMessage(json.updated ?? selected.size), {
        description: json.variationOverridesUntouched > 0
          ? `${json.variationOverridesUntouched} preço(s) específico(s) de variação foram mantidos.`
          : undefined,
      })
      setSelected(new Set())
      setPricing(false)
      router.refresh()
    } catch {
      toast.error('Não foi possível concluir a ação', { description: 'Erro de rede.' })
    } finally {
      setBusy(false)
    }
  }

  const n = selected.size
  const plural = (count: number) => `${count} produto${count !== 1 ? 's' : ''}`
  const percentNumber = Number(percent.replace(',', '.'))

  return (
    <Card>
      <CardHeader className="text-sm text-text-muted">{total} itens</CardHeader>

      {n > 0 && (
        <div className="flex flex-wrap items-center gap-2 border-y border-border bg-bg-overlay px-4 py-2 text-sm">
          <span className="font-medium">{plural(n)} selecionado{n !== 1 ? 's' : ''}</span>
          <Button size="sm" disabled={busy}
            onClick={() => run({ wholesale_enabled: true }, `Ativar ${plural(n)} no atacado?`, (c) => `${plural(c)} ativado${c !== 1 ? 's' : ''} no atacado.`)}>
            Ativar no atacado
          </Button>
          <Button size="sm" variant="outline" disabled={busy}
            onClick={() => run({ wholesale_enabled: false }, `Desativar ${plural(n)} no atacado?`, (c) => `${plural(c)} desativado${c !== 1 ? 's' : ''} no atacado.`)}>
            Desativar no atacado
          </Button>
          <Button size="sm" variant="outline" disabled={busy} onClick={() => setPricing((v) => !v)}>
            Definir preço de atacado
          </Button>
          <button type="button" className="ml-auto text-xs text-text-muted underline" onClick={() => setSelected(new Set())}>Limpar seleção</button>

          {pricing && (
            <div className="flex w-full flex-wrap items-center gap-2 pt-2">
              <span>Preço de atacado =</span>
              <input
                type="number" min="1" max="100" step="0.01" value={percent}
                onChange={(e) => setPercent(e.target.value)}
                className="input-base w-24 py-1.5 text-sm"
              />
              <span>% do preço de varejo</span>
              <Button size="sm" disabled={busy || !(percentNumber >= 1 && percentNumber <= 100)}
                onClick={() => run(
                  { wholesale_price_percent: percentNumber },
                  `Definir o preço de atacado de ${plural(n)} como ${percentNumber}% do preço de varejo?\n\nIsso substitui o preço de atacado atual dos produtos selecionados. Preços específicos de variações não são alterados.`,
                  (c) => `Preço de atacado definido em ${plural(c)}.`,
                )}>
                Aplicar
              </Button>
            </div>
          )}
        </div>
      )}

      <div className="overflow-x-auto">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead className="w-8">
                <input type="checkbox" aria-label="Selecionar todos da página" checked={allSelected} onChange={toggleAll} className="accent-brand" />
              </TableHead>
              <TableHead>Produto</TableHead>
              <TableHead>SKU</TableHead>
              <TableHead>Categoria</TableHead>
              <TableHead>Fornecedor</TableHead>
              <TableHead>Marca</TableHead>
              <TableHead>Custo</TableHead>
              <TableHead>Preço</TableHead>
              <TableHead>Margem</TableHead>
              <TableHead>Status</TableHead>
              <TableHead>Atacado</TableHead>
              <TableHead className="text-right">Ações</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.map((product) => {
              const status = WHOLESALE_STATUS_LABEL[product.wholesaleStatus]
              const enabled = product.wholesaleStatus !== 'disabled'
              return (
                <TableRow key={product.id}>
                  <TableCell>
                    <input type="checkbox" aria-label={`Selecionar ${product.name}`} checked={selected.has(product.id)} onChange={() => toggle(product.id)} className="accent-brand" />
                  </TableCell>
                  <TableCell>
                    <div className="flex items-center gap-3">
                      <ProductThumb url={product.displayUrl} name={product.name} />
                      <div className="font-medium">
                        {product.name}
                        {product.isKit && (
                          <span className="ml-1.5 inline-block rounded bg-brand/10 px-1.5 py-0.5 text-[10px] font-semibold uppercase text-brand align-middle">Kit</span>
                        )}
                      </div>
                    </div>
                  </TableCell>
                  <TableCell><code>{product.sku}</code></TableCell>
                  <TableCell>{product.category ?? '—'}</TableCell>
                  <TableCell>{product.supplier ?? '—'}</TableCell>
                  <TableCell>{product.brand ?? '—'}</TableCell>
                  <TableCell>{formatCurrency(product.base_cost)}</TableCell>
                  <TableCell>{formatCurrency(product.base_price)}</TableCell>
                  <TableCell>
                    <span className={product.margin_pct >= 40 ? 'text-success' : product.margin_pct >= 25 ? 'text-warning' : 'text-error'}>
                      {formatPercent(product.margin_pct)}
                    </span>
                  </TableCell>
                  <TableCell>
                    <Badge variant={product.active ? 'default' : 'secondary'}>{product.active ? 'Ativo' : 'Inativo'}</Badge>
                  </TableCell>
                  <TableCell>
                    <div className="flex flex-col items-start gap-1">
                      <span title={status.description}><Badge variant={status.variant}>{status.short}</Badge></span>
                      {enabled && !product.hasImage && <span className="text-[11px] text-warning">sem imagem</span>}
                    </div>
                  </TableCell>
                  <TableCell className="text-right">
                    <div className="flex justify-end gap-2">
                      <Link href={`/produtos/${product.id}`}><Button variant="outline" size="sm">Ver</Button></Link>
                      <DeleteProductButton id={product.id} />
                    </div>
                  </TableCell>
                </TableRow>
              )
            })}
          </TableBody>
        </Table>
      </div>
    </Card>
  )
}

function ProductThumb({ url, name }: { url: string | null; name: string }) {
  if (url) return <Image src={url} alt={name} width={40} height={40} className="h-10 w-10 rounded-md object-cover" />
  return (
    <div className="flex h-10 w-10 items-center justify-center rounded-md bg-bg-overlay">
      <Package className="h-4 w-4 text-text-muted" />
    </div>
  )
}
