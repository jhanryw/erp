import { NextResponse } from 'next/server'
import { getAlerts } from '@/lib/alerts/getAlerts'

export async function POST() {
  const apiUrl = process.env.EVOLUTION_API_URL
  const apiKey = process.env.EVOLUTION_API_KEY
  const instance = process.env.EVOLUTION_INSTANCE
  const phone = process.env.ALERT_PHONE_NUMBER

  if (!apiUrl || !apiKey || !instance || !phone) {
    return NextResponse.json(
      { error: 'Variáveis de ambiente não configuradas: EVOLUTION_API_URL, EVOLUTION_API_KEY, EVOLUTION_INSTANCE, ALERT_PHONE_NUMBER' },
      { status: 500 }
    )
  }

  const alerts = await getAlerts()
  const critical = alerts.filter((a) => a.severity === 'high')

  if (critical.length === 0) {
    return NextResponse.json({ ok: true, sent: false, reason: 'Nenhum alerta crítico hoje.' })
  }

  const lines = critical.map((a) => `- ${a.message}`).join('\n')
  const message = `🚨 *ALERTAS DO DIA*\n\n${lines}`

  const res = await fetch(`${apiUrl}/message/sendText/${instance}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      apikey: apiKey,
    },
    body: JSON.stringify({
      number: phone,
      text: message,
    }),
  })

  if (!res.ok) {
    const body = await res.text()
    console.error('Erro ao enviar WhatsApp:', body)
    return NextResponse.json({ error: 'Falha ao enviar mensagem', detail: body }, { status: 502 })
  }

  return NextResponse.json({ ok: true, sent: true, count: critical.length })
}
