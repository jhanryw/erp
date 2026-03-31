import { NextResponse } from 'next/server'

export async function POST(request: Request) {
  const raw = await request.text()

  console.log('🔥 WEBHOOK NUVEMSHOP RECEBIDO')
  console.log(raw)

  return NextResponse.json({ ok: true })
}