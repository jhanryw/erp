import { NextResponse } from 'next/server'
import { getAlerts } from '@/lib/alerts/getAlerts'

// Job de alerta diário via WhatsApp. Chamado máquina-a-máquina (sem sessão
// de usuário) — autenticado por CRON_SECRET, mesmo padrão de /api/jobs/*.
// /api/alerts/daily está liberada no middleware especificamente (não o
// prefixo /api/alerts/ inteiro); a segurança real é este Bearer check.
export async function POST(request: Request) {
  const authHeader = request.headers.get('Authorization')
  if (authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

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

  // Empresa exclusivamente de variável de ambiente — nunca de body, query
  // string ou header controlado pelo chamador. Solução operacional para o
  // cenário atual de uma empresa e um destinatário global; quando existir
  // uma segunda empresa com alertas próprios, isso vira configuração por
  // empresa (fora do escopo desta correção).
  const companyIdRaw = process.env.ALERT_COMPANY_ID
  const companyId = companyIdRaw ? Number(companyIdRaw) : NaN

  if (!companyIdRaw || Number.isNaN(companyId)) {
    return NextResponse.json(
      { error: 'Variável de ambiente não configurada ou inválida: ALERT_COMPANY_ID' },
      { status: 500 }
    )
  }

  const alerts = await getAlerts(companyId)
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
