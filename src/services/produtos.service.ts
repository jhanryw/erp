/**
 * Service de Produtos — lógica de negócio desacoplada de HTTP.
 *
 * Responsabilidade: validações de integridade, regras de negócio e
 * operações de banco que envolvem múltiplas tabelas.
 *
 * As API routes importam daqui e apenas lidam com HTTP (parse, auth, response).
 */

import { createAdminClient } from '@/lib/supabase/admin'

// ─── Tipos ────────────────────────────────────────────────────────────────────

export interface ServiceResult<T = void> {
  ok: true
  data: T
  error?: never
  status?: never
}

export interface ServiceError {
  ok: false
  data?: never
  error: string
  /** HTTP status code sugerido para a API route */
  status: number
}

export type ServiceOutcome<T = void> = ServiceResult<T> | ServiceError

// ─── Helpers internos ─────────────────────────────────────────────────────────

function success<T>(data: T): ServiceResult<T> {
  return { ok: true, data }
}

function failure(error: string, status = 500): ServiceError {
  return { ok: false, error, status }
}

// ─── Verificações de integridade ──────────────────────────────────────────────

/**
 * Verifica se um produto pode ser excluído com segurança.
 *
 * Regras:
 * 1. Produto não pode ter estoque positivo em nenhuma variação.
 * 2. Produto não pode ter itens de venda associados.
 *
 * Retorna ok:true se a exclusão for permitida, ou um erro descritivo.
 */
export async function canDeleteProduct(productId: number): Promise<ServiceOutcome<{ variationIds: number[] }>> {
  const admin = createAdminClient()

  // Buscar variações
  const { data: variations, error: varErr } = await admin
    .from('product_variations')
    .select('id')
    .eq('product_id', productId) as unknown as {
      data: { id: number }[] | null
      error: { message: string } | null
    }

  if (varErr) return failure(varErr.message)

  const variationIds = (variations ?? []).map((v) => v.id)

  if (variationIds.length === 0) {
    // Produto sem variações — pode ser excluído
    return success({ variationIds: [] })
  }

  // Regra 1: estoque positivo
  const { data: stockRows, error: stockErr } = await admin
    .from('stock')
    .select('quantity')
    .in('product_variation_id', variationIds)
    .gt('quantity', 0) as unknown as {
      data: { quantity: number }[] | null
      error: { message: string } | null
    }

  if (stockErr) return failure(stockErr.message)

  if (stockRows && stockRows.length > 0) {
    const totalQty = stockRows.reduce((s, r) => s + (r.quantity ?? 0), 0)
    return failure(
      `Produto não pode ser excluído: há ${totalQty} unidade(s) em estoque. Zere o estoque antes de excluir.`,
      409
    )
  }

  // Regra 2: vendas associadas
  const { count: saleCount, error: saleErr } = await admin
    .from('sale_items')
    .select('id', { count: 'exact', head: true })
    .in('product_variation_id', variationIds)

  if (saleErr) return failure(saleErr.message)

  if (saleCount && saleCount > 0) {
    return failure(
      `Produto não pode ser excluído: possui ${saleCount} item(ns) em vendas registradas.`,
      409
    )
  }

  return success({ variationIds })
}

/**
 * Verifica se o preço base de um produto pode ser alterado.
 *
 * Regra: se o produto já possui vendas, alteração de preço é permitida
 * (o histórico de vendas preserva os preços originais em sale_items).
 * Mas se `base_cost` for reduzido para abaixo do custo médio atual em estoque,
 * emite um warning (não bloqueia — decisão de negócio do admin).
 *
 * Retorna { ok: true } sempre, mas pode incluir `warning` para a UI exibir.
 */
export async function checkPriceChange(
  productId: number,
  newBasePrice: number,
  newBaseCost: number
): Promise<{ ok: true; warning?: string }> {
  const admin = createAdminClient()

  // Verificar custo médio atual em estoque
  const { data: stockRows } = await admin
    .from('stock')
    .select('avg_cost, quantity, product_variation_id')
    .gt('quantity', 0) as unknown as {
      data: { avg_cost: number; quantity: number; product_variation_id: number }[] | null
    }

  if (stockRows && stockRows.length > 0) {
    const maxAvgCost = Math.max(...stockRows.map((r) => r.avg_cost ?? 0))
    if (newBaseCost < maxAvgCost * 0.9) {
      return {
        ok: true,
        warning: `Novo custo (${newBaseCost}) está 10%+ abaixo do custo médio em estoque (${maxAvgCost.toFixed(2)}). Verifique se está correto.`,
      }
    }
  }

  // Preço de venda abaixo do custo — warning
  if (newBasePrice < newBaseCost) {
    return {
      ok: true,
      warning: `Preço de venda (${newBasePrice}) está abaixo do custo (${newBaseCost}). Margem negativa.`,
    }
  }

  return { ok: true }
}

/**
 * Retorna snapshot do produto para auditoria (before/after).
 */
export async function getProductSnapshot(productId: number): Promise<Record<string, unknown> | null> {
  const admin = createAdminClient()
  const { data } = await admin
    .from('products')
    .select('id, name, sku, base_cost, base_price, active, category_id, supplier_id')
    .eq('id', productId)
    .single() as unknown as { data: Record<string, unknown> | null }
  return data
}

/**
 * Executa a exclusão em cascata de um produto e suas variações.
 * Assume que canDeleteProduct() já foi chamado e retornou ok:true.
 */
export async function deleteProductCascade(
  productId: number,
  variationIds: number[]
): Promise<ServiceOutcome> {
  const admin = createAdminClient()

  if (variationIds.length > 0) {
    // Atributos de variação
    const { error: attrErr } = await admin
      .from('product_variation_attributes')
      .delete()
      .in('product_variation_id', variationIds)
    if (attrErr) return failure(attrErr.message)

    // Lotes de estoque
    const { error: lotsErr } = await admin
      .from('stock_lots')
      .delete()
      .in('product_variation_id', variationIds)
    if (lotsErr) return failure(lotsErr.message)

    // Posição de estoque
    const { error: stockErr } = await admin
      .from('stock')
      .delete()
      .in('product_variation_id', variationIds)
    if (stockErr) return failure(stockErr.message)

    // Variações
    const { error: varErr } = await admin
      .from('product_variations')
      .delete()
      .eq('product_id', productId)
    if (varErr) return failure(varErr.message)
  }

  // Produto
  const { error: prodErr } = await admin
    .from('products')
    .delete()
    .eq('id', productId)
  if (prodErr) return failure(prodErr.message)

  return success(undefined)
}
