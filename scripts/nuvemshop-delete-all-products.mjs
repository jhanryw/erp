/**
 * Deleta TODOS os produtos da Nuvemshop e limpa a tabela produto_map.
 *
 * USO:
 *   NUVEMSHOP_ACCESS_TOKEN=xxx NUVEMSHOP_STORE_ID=yyy \
 *   SUPABASE_URL=zzz SUPABASE_SERVICE_ROLE_KEY=www \
 *   node scripts/nuvemshop-delete-all-products.mjs
 *
 * Ou se suas variáveis já estão em algum arquivo, passe com dotenv:
 *   node -r dotenv/config --env-file=.env.local scripts/nuvemshop-delete-all-products.mjs
 */

const TOKEN    = process.env.NUVEMSHOP_ACCESS_TOKEN
const STORE_ID = process.env.NUVEMSHOP_STORE_ID
const SUPA_URL = process.env.NEXT_PUBLIC_SUPABASE_URL || process.env.SUPABASE_URL
const SUPA_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY

// ── Validação das variáveis ────────────────────────────────────────────────────

if (!TOKEN || !STORE_ID) {
  console.error('❌  Faltam NUVEMSHOP_ACCESS_TOKEN e/ou NUVEMSHOP_STORE_ID')
  process.exit(1)
}

const BASE      = `https://api.tiendanube.com/v1/${STORE_ID}`
const HEADERS   = {
  Authentication: `bearer ${TOKEN}`,
  'Content-Type': 'application/json',
  'User-Agent':   'erp-nuvemshop-delete-script',
}

// ── Buscar todos os IDs de produtos (paginado) ────────────────────────────────

async function fetchAllProductIds() {
  const ids = []
  let page = 1

  while (true) {
    const res = await fetch(`${BASE}/products?page=${page}&per_page=200&fields=id`, {
      headers: HEADERS,
    })

    if (!res.ok) {
      const txt = await res.text()
      throw new Error(`Erro ao listar produtos (pág ${page}): ${res.status} ${txt}`)
    }

    const products = await res.json()
    if (!Array.isArray(products) || products.length === 0) break

    ids.push(...products.map(p => p.id))
    console.log(`  Página ${page}: ${products.length} produtos encontrados`)

    if (products.length < 200) break
    page++

    // Respeita rate limit da Nuvemshop (~2 req/s)
    await sleep(600)
  }

  return ids
}

// ── Deletar produto por ID ────────────────────────────────────────────────────

async function deleteProduct(id) {
  const res = await fetch(`${BASE}/products/${id}`, {
    method: 'DELETE',
    headers: HEADERS,
  })

  // 200 ou 204 = sucesso; 404 = já foi deletado (ok)
  if (!res.ok && res.status !== 404) {
    const txt = await res.text()
    throw new Error(`Erro ao deletar produto ${id}: ${res.status} ${txt}`)
  }
}

// ── Limpar produto_map no Supabase ────────────────────────────────────────────

async function clearProdutoMap() {
  if (!SUPA_URL || !SUPA_KEY) {
    console.log('⚠️  SUPABASE_URL ou SUPABASE_SERVICE_ROLE_KEY não definidos — pulando limpeza do produto_map')
    return
  }

  const res = await fetch(`${SUPA_URL}/rest/v1/produto_map?source=eq.nuvemshop`, {
    method: 'DELETE',
    headers: {
      apikey: SUPA_KEY,
      Authorization: `Bearer ${SUPA_KEY}`,
      'Content-Type': 'application/json',
      Prefer: 'return=minimal',
    },
  })

  if (!res.ok) {
    const txt = await res.text()
    console.error(`⚠️  Erro ao limpar produto_map: ${res.status} ${txt}`)
  } else {
    console.log('✅  produto_map limpa (registros nuvemshop removidos)')
  }
}

// ── Utilitário ────────────────────────────────────────────────────────────────

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms))
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  console.log(`\n🔍  Buscando todos os produtos da loja ${STORE_ID}…\n`)

  const ids = await fetchAllProductIds()

  if (ids.length === 0) {
    console.log('✅  Nenhum produto encontrado. Loja já está limpa.')
    await clearProdutoMap()
    return
  }

  console.log(`\n🗑️   ${ids.length} produtos encontrados. Iniciando exclusão…\n`)

  let deleted = 0
  let errors  = 0

  for (const id of ids) {
    try {
      await deleteProduct(id)
      deleted++
      process.stdout.write(`  [${deleted}/${ids.length}] produto ${id} deletado\n`)
    } catch (err) {
      errors++
      console.error(`  ❌  ${err.message}`)
    }

    // Rate limit: ~2 req/s
    await sleep(600)
  }

  console.log(`\n📊  Resultado: ${deleted} deletados, ${errors} erros\n`)

  await clearProdutoMap()

  if (errors > 0) {
    console.log('⚠️  Alguns produtos não foram deletados. Rode o script novamente para tentar de novo.')
    process.exit(1)
  } else {
    console.log('✅  Loja limpa com sucesso.')
  }
}

main().catch(err => {
  console.error('Erro fatal:', err)
  process.exit(1)
})
