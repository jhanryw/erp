#!/usr/bin/env node

/**
 * Script para deletar TODOS os produtos da Nuvemshop
 * Use com cuidado — não há volta!
 *
 * npm run delete-nuvemshop-products
 */

const storeId = process.env.NUVEMSHOP_STORE_ID
const token = process.env.NUVEMSHOP_ACCESS_TOKEN

if (!storeId || !token) {
  console.error('❌ NUVEMSHOP_STORE_ID e NUVEMSHOP_ACCESS_TOKEN são obrigatórios no .env')
  process.exit(1)
}

const baseUrl = `https://api.tiendanube.com/v1/${storeId}`
const headers = {
  'Authentication': `bearer ${token}`,
  'User-Agent': 'erp-nuvemshop-delete',
  'Content-Type': 'application/json',
}

async function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

async function listProducts(page = 1) {
  const res = await fetch(`${baseUrl}/products?page=${page}&per_page=100`, { headers })
  if (!res.ok) throw new Error(`Erro ao listar produtos: ${res.status}`)
  return res.json()
}

async function deleteProduct(productId) {
  const res = await fetch(`${baseUrl}/products/${productId}`, {
    method: 'DELETE',
    headers,
  })
  if (!res.ok) throw new Error(`Erro ao deletar #${productId}: ${res.status}`)
  return res.json()
}

async function main() {
  console.log('🗑️  Deletando TODOS os produtos da Nuvemshop...')
  console.log(`Store ID: ${storeId}\n`)

  let page = 1
  let totalDeleted = 0
  let hasMore = true

  while (hasMore) {
    try {
      const response = await listProducts(page)
      const products = response.products || []

      if (products.length === 0) {
        hasMore = false
        break
      }

      console.log(`📄 Página ${page}: ${products.length} produtos encontrados`)

      for (const product of products) {
        try {
          await deleteProduct(product.id)
          totalDeleted++
          console.log(`  ✓ Deletado: ${product.id} - ${product.name.pt || product.name}`)
          await sleep(500) // Respeitar rate limit
        } catch (err) {
          console.error(`  ✗ Erro ao deletar #${product.id}:`, err.message)
        }
      }

      // Se a página anterior tinha menos de 100, não há mais páginas
      if (products.length < 100) {
        hasMore = false
      } else {
        page++
      }
    } catch (err) {
      console.error('❌ Erro ao listar produtos:', err.message)
      hasMore = false
    }
  }

  console.log(`\n✅ Concluído! ${totalDeleted} produtos deletados.`)
}

main().catch(console.error)
