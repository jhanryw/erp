export const dynamic = 'force-dynamic'

import { NextResponse } from 'next/server'
import { fetchCEP } from '@/lib/services/cepService'
import { geocodeAddress } from '@/lib/services/geocodingService'
import { resolveIbgeCascade } from '@/lib/services/resolveIbgeCascade'
import { z } from 'zod'
import type { ViaCEPResponse } from '@/lib/services/cepService'

const schema = z.object({
  cep: z.string().min(5),
})

// Fase Fiscal 5C — o campo `ibge` já vinha na resposta do ViaCEP
// (`cepService.ts`) mas era descartado antes de chegar ao chamador. Agora
// é preservado (camada 1 da cascata) com fallback para
// `resolveMunicipioIbge` por UF+cidade (camada 2, já existente desde a
// Fase Fiscal 2B) — nunca pede código IBGE digitado manualmente.
async function buildAddressResponse(cepData: ViaCEPResponse) {
  const address = `${cepData.logradouro}, ${cepData.bairro}, ${cepData.localidade}, ${cepData.uf}, Brasil`
  const [coords, ibge] = await Promise.all([
    geocodeAddress(address),
    resolveIbgeCascade({
      viaCepIbge: cepData.ibge ?? null,
      uf:         cepData.uf ?? null,
      municipio:  cepData.localidade ?? null,
    }),
  ])

  return {
    cep:              cepData.cep,
    street:           cepData.logradouro,
    neighborhood:     cepData.bairro,
    city:             cepData.localidade,
    state:            cepData.uf,
    complement:       cepData.complemento,
    latitude:         coords?.lat,
    longitude:        coords?.lon,
    municipio_ibge:   ibge.codigo,
    ibge_source:      ibge.source,
  }
}

export async function GET(request: Request) {
  try {
    const { searchParams } = new URL(request.url)
    const cep = searchParams.get('cep') ?? ''

    const parsed = schema.safeParse({ cep })
    if (!parsed.success) {
      return NextResponse.json({ error: 'CEP inválido' }, { status: 422 })
    }

    const cepData = await fetchCEP(parsed.data.cep)
    if (!cepData) {
      return NextResponse.json({ error: 'CEP não encontrado' }, { status: 404 })
    }

    return NextResponse.json(await buildAddressResponse(cepData))
  } catch (error) {
    console.error('[API Shipping CEP GET]', error)
    return NextResponse.json({ error: 'Erro ao processar requisição' }, { status: 500 })
  }
}

export async function POST(request: Request) {
  try {
    const body = await request.json()

    const parsed = schema.safeParse(body)
    if (!parsed.success) {
      return NextResponse.json({ error: parsed.error.flatten() }, { status: 422 })
    }

    const cepData = await fetchCEP(parsed.data.cep)
    if (!cepData) {
      return NextResponse.json({ error: 'CEP não encontrado' }, { status: 404 })
    }

    return NextResponse.json(await buildAddressResponse(cepData))
  } catch (error) {
    console.error('[API Shipping CEP]', error)
    return NextResponse.json({ error: 'Erro ao processar requisição' }, { status: 500 })
  }
}
