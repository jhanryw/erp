export const dynamic = 'force-dynamic'

import { NextResponse } from 'next/server'
import { fetchCEP } from '@/lib/services/cepService'
import { geocodeAddress } from '@/lib/services/geocodingService'
import { z } from 'zod'

const schema = z.object({
  cep: z.string().min(5),
})

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

    const address = `${cepData.logradouro}, ${cepData.bairro}, ${cepData.localidade}, ${cepData.uf}, Brasil`
    const coords = await geocodeAddress(address)

    return NextResponse.json({
      cep:          cepData.cep,
      street:       cepData.logradouro,
      neighborhood: cepData.bairro,
      city:         cepData.localidade,
      state:        cepData.uf,
      complement:   cepData.complemento,
      latitude:     coords?.lat,
      longitude:    coords?.lon,
    })
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

    // Fetch CEP data
    const cepData = await fetchCEP(parsed.data.cep)

    if (!cepData) {
      return NextResponse.json({ error: 'CEP não encontrado' }, { status: 404 })
    }

    // Try to geocode the address
    const address = `${cepData.logradouro}, ${cepData.bairro}, ${cepData.localidade}, ${cepData.uf}, Brasil`
    const coords = await geocodeAddress(address)

    return NextResponse.json({
      cep: cepData.cep,
      street: cepData.logradouro,
      neighborhood: cepData.bairro,
      city: cepData.localidade,
      state: cepData.uf,
      complement: cepData.complemento,
      latitude: coords?.lat,
      longitude: coords?.lon,
    })
  } catch (error) {
    console.error('[API Shipping CEP]', error)
    return NextResponse.json({ error: 'Erro ao processar requisição' }, { status: 500 })
  }
}
