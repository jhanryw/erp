import { NextResponse } from 'next/server'

/**
 * Fluxo OAuth Nuvemshop:
 * 1. GET sem params → redireciona para autorizar
 * 2. Nuvemshop redireciona de volta com ?code=XXX&user_id=YYY
 * 3. GET com params → troca code por access_token
 */

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url)
  const code = searchParams.get('code')
  const userId = searchParams.get('user_id')

  // ── Recebendo callback com code ────────────────────────────────────────────
  if (code && userId) {
    try {
      const clientId = process.env.NUVEMSHOP_APP_ID ?? '21089'
      const clientSecret = process.env.NUVEMSHOP_CLIENT_SECRET ?? ''

      const tokenRes = await fetch('https://www.tiendanube.com/apps/authorize/token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          client_id: clientId,
          client_secret: clientSecret,
          grant_type: 'authorization_code',
          code,
        }),
      })

      if (!tokenRes.ok) {
        const error = await tokenRes.text()
        console.error('[nuvemshop/connect] Token exchange failed', error)
        return NextResponse.json(
          { error: 'Failed to exchange code for token.', details: error },
          { status: 502 }
        )
      }

      const data = (await tokenRes.json()) as { access_token?: string }

      return NextResponse.json({
        ok: true,
        access_token: data.access_token,
        user_id: userId,
        message: `✅ Sucesso! Coloca no .env:\nNUVEMSHOP_ACCESS_TOKEN=${data.access_token}\nNUVEMSHOP_STORE_ID=${userId}`,
      })
    } catch (err) {
      console.error('[nuvemshop/connect]', err)
      return NextResponse.json({ error: 'Internal server error.' }, { status: 500 })
    }
  }

  // ── Iniciando fluxo OAuth ──────────────────────────────────────────────────
  const clientId = process.env.NUVEMSHOP_APP_ID ?? '21089'
  const host = request.headers.get('host') || 'santtorini.qarvon.com'
  const protocol = request.headers.get('x-forwarded-proto') || 'https'
  const redirectUri = `${protocol}://${host}/api/integrations/nuvemshop/connect`

  const authUrl = new URL('https://www.tiendanube.com/apps/authorize')
  authUrl.searchParams.append('client_id', clientId)
  authUrl.searchParams.append('redirect_uri', redirectUri)
  authUrl.searchParams.append('scopes', 'read_products,write_products,read_orders,write_orders')

  return NextResponse.redirect(authUrl.toString())
}
