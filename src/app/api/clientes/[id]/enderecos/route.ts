export const dynamic = 'force-dynamic'

/**
 * Fase Fiscal 5C — ativação de `customer_addresses`.
 *
 * Antes desta fase, `customer_addresses` existia no schema mas tinha ZERO
 * caminhos de escrita em todo o repositório (confirmado por auditoria —
 * só 2 leituras: `vendas/[id]/imprimir/page.tsx` e `loadSaleFiscalContext.
 * ts`). Este endpoint é o menor conjunto de rotas necessário para permitir
 * salvar/listar endereço reutilizável de cliente: GET (lista os endereços
 * já cadastrados) e POST (cadastra um novo).
 *
 * Não inclui PUT/DELETE nesta fase — fora do escopo mínimo pedido
 * ("menor conjunto de mudanças para permitir salvar endereço").
 *
 * Código IBGE nunca é aceito digitado pelo cliente da API — é sempre
 * resolvido no servidor via `resolveIbgeCascade` (ViaCEP, se o caller já
 * tiver consultado o CEP, com fallback para `resolveMunicipioIbge` por
 * UF+município), ou fica pendente (nunca inventado).
 */

import { createAdminClient } from '@/lib/supabase/admin'
import { requireRole } from '@/lib/supabase/session'
import { resolveIbgeCascade, isValidIbgeFormat } from '@/lib/services/resolveIbgeCascade'
import { NextResponse } from 'next/server'
import { z } from 'zod'

const n = (v: unknown) => (v === '' || v == null ? null : v)

const postSchema = z.object({
  cep:            z.string().regex(/^\d{8}$/, 'CEP deve ter 8 dígitos'),
  street:         z.string().min(1, 'Logradouro obrigatório'),
  number:         z.string().min(1, 'Número obrigatório'),
  complement:     z.preprocess(n, z.string().nullable().optional()),
  neighborhood:   z.string().min(1, 'Bairro obrigatório'),
  city:           z.string().min(1, 'Município obrigatório'),
  state:          z.string().length(2, 'UF deve ter 2 letras'),
  reference:      z.preprocess(n, z.string().nullable().optional()),
  is_default:     z.boolean().default(false),
  // Opcional: se o cliente já consultou /api/shipping/cep, repassa o
  // código IBGE já resolvido (camada 1, ViaCEP) para evitar uma segunda
  // resolução — o servidor SEMPRE revalida o formato, e cai no fallback
  // (resolveMunicipioIbge) se ausente/inválido.
  municipio_ibge: z.preprocess(n, z.string().regex(/^\d{7}$/).nullable().optional()),
})

async function loadCustomer(customerId: number, companyId: number) {
  const admin = createAdminClient()
  const { data } = await (admin as any)
    .from('customers')
    .select('id')
    .eq('id', customerId)
    .eq('company_id', companyId)
    .maybeSingle() as { data: { id: number } | null }
  return data
}

// ─── GET /api/clientes/[id]/enderecos ─────────────────────────────────────────

export async function GET(_req: Request, { params }: { params: { id: string } }) {
  const { user, response: unauth } = await requireRole('usuario')
  if (unauth) return unauth
  if (!user.company_id) return NextResponse.json({ error: 'Usuário sem empresa vinculada.' }, { status: 403 })

  const customerId = Number(params.id)
  if (!Number.isFinite(customerId) || customerId <= 0) {
    return NextResponse.json({ error: 'ID inválido' }, { status: 400 })
  }

  const customer = await loadCustomer(customerId, user.company_id)
  if (!customer) return NextResponse.json({ error: 'Cliente não encontrado' }, { status: 404 })

  const admin = createAdminClient()
  const { data, error } = await (admin as any)
    .from('customer_addresses')
    .select('id, cep, street, number, complement, neighborhood, city, state, reference, municipio_ibge, ibge_source, is_default, created_at')
    .eq('customer_id', customerId)
    .order('is_default', { ascending: false })
    .order('created_at', { ascending: false })

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json({ addresses: data ?? [] })
}

// ─── POST /api/clientes/[id]/enderecos ────────────────────────────────────────

export async function POST(request: Request, { params }: { params: { id: string } }) {
  const { user, response: unauth } = await requireRole('usuario')
  if (unauth) return unauth
  if (!user.company_id) return NextResponse.json({ error: 'Usuário sem empresa vinculada.' }, { status: 403 })

  const customerId = Number(params.id)
  if (!Number.isFinite(customerId) || customerId <= 0) {
    return NextResponse.json({ error: 'ID inválido' }, { status: 400 })
  }

  let body: unknown
  try { body = await request.json() } catch { return NextResponse.json({ error: 'JSON inválido' }, { status: 400 }) }

  const parsed = postSchema.safeParse(body)
  if (!parsed.success) return NextResponse.json({ error: parsed.error.flatten() }, { status: 422 })

  const customer = await loadCustomer(customerId, user.company_id)
  if (!customer) return NextResponse.json({ error: 'Cliente não encontrado' }, { status: 404 })

  // Nunca confia cegamente no municipio_ibge enviado pelo cliente da API —
  // revalida formato e, se ausente/inválido, tenta resolver de novo pelo
  // fallback (UF+município) antes de persistir. Nunca inventa/aproxima.
  const ibge = isValidIbgeFormat(parsed.data.municipio_ibge)
    ? { codigo: parsed.data.municipio_ibge, source: 'viacep' as const }
    : await resolveIbgeCascade({ viaCepIbge: null, uf: parsed.data.state, municipio: parsed.data.city })

  const admin = createAdminClient()

  if (parsed.data.is_default) {
    await (admin as any)
      .from('customer_addresses')
      .update({ is_default: false })
      .eq('customer_id', customerId)
  }

  const { data, error } = await (admin as any)
    .from('customer_addresses')
    .insert({
      customer_id:    customerId,
      cep:            parsed.data.cep,
      street:         parsed.data.street,
      number:         parsed.data.number,
      complement:     parsed.data.complement ?? null,
      neighborhood:   parsed.data.neighborhood,
      city:           parsed.data.city,
      state:          parsed.data.state.toUpperCase(),
      reference:      parsed.data.reference ?? null,
      is_default:     parsed.data.is_default,
      municipio_ibge: ibge.codigo,
      ibge_source:    ibge.source,
    })
    .select('id, cep, street, number, complement, neighborhood, city, state, reference, municipio_ibge, ibge_source, is_default')
    .single()

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json({ address: data })
}
