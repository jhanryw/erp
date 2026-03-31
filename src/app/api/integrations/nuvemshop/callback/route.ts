import { NextResponse } from 'next/server'

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url)
  const code = searchParams.get('code')

  if (!code) {
    return NextResponse.json({ error: 'code obrigatório.' }, { status: 400 })
  }

  try {
    const res = await fetch('https://www.tiendanube.com/apps/authorize/token', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        client_id:     process.env.NUVEMSHOP_APP_ID,
        client_secret: process.env.NUVEMSHOP_CLIENT_SECRET,
        grant_type:    'authorization_code',
        code,
      }),
    })

    if (!res.ok) {
      const text = await res.text()
      console.error('[nuvemshop/callback] Erro na troca de token', res.status, text)
      return NextResponse.json({ error: 'Falha ao obter token.' }, { status: 502 })
    }

    const data = await res.json() as { access_token: string; user_id: number }

    return NextResponse.json({ ok: true, access_token: data.access_token, user_id: data.user_id })
  } catch (err) {
    console.error('[nuvemshop/callback] Exceção não tratada', err)
    return NextResponse.json({ error: 'Erro interno do servidor.' }, { status: 500 })
  }
}
