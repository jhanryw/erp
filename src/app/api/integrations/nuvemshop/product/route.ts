import { NextResponse } from 'next/server'
import { requireNuvemshopRouteContext } from '@/services/nuvemshop/routeContext'
import { publishProductToNuvemshop } from '@/services/nuvemshop/publish.service'
import { isPublishOk, publishHttpStatus } from '@/services/nuvemshop/publishHttp'

/** Publica UM produto (página do produto). Delegado ao service canônico. */
export async function POST(request: Request) {
  const { ctx, response } = await requireNuvemshopRouteContext('gerente')
  if (response) return response

  let body: { produto_id?: number }
  try {
    body = await request.json()
  } catch {
    return NextResponse.json({ error: 'JSON inválido.' }, { status: 400 })
  }

  const produtoId = Number(body.produto_id)
  if (!Number.isInteger(produtoId) || produtoId <= 0) {
    return NextResponse.json({ error: 'produto_id obrigatório.' }, { status: 400 })
  }

  const result = await publishProductToNuvemshop(ctx, produtoId)
  const ok = isPublishOk(result)
  return NextResponse.json(
    {
      ok,
      status:          result.status,
      external_id:     result.remoteProductId ?? null,
      skipped:         result.status === 'already_published',
      variants_mapped: result.variantsMapped ?? 0,
      ...(ok ? {} : { error: result.message, code: result.code ?? null, sku_issues: result.skuIssues, unmatched: result.unmatched }),
    },
    { status: publishHttpStatus(result) },
  )
}
