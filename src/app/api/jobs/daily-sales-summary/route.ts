export const dynamic = 'force-dynamic'

import { NextResponse } from 'next/server'
import { createAdminClient } from '@/lib/supabase/admin'
import { brazilDate } from '@/lib/utils/date'
import { sendPushNotification } from '@/lib/push/send'

const currency = new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' })

export async function POST(request: Request) {
  // Proteger endpoint com CRON_SECRET — mesmo padrão de /api/jobs/cashback-release
  const authHeader = request.headers.get('Authorization')
  if (authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const admin = createAdminClient()
  const today = brazilDate()

  // Só processa empresas com alguém inscrito a receber push de admin —
  // evita calcular e tentar enviar para empresas sem nenhum dispositivo ativo.
  const { data: subCompanies } = await (admin as any)
    .from('push_subscriptions')
    .select('company_id')
    .eq('active', true)
    .eq('role', 'admin') as { data: { company_id: number }[] | null }

  const companyIds: number[] = Array.from(new Set((subCompanies ?? []).map((r) => r.company_id)))

  const results: { companyId: number; revenue: number; orders: number }[] = []

  for (const companyId of companyIds) {
    // Mesma regra de negócio EXATA do card "Faturamento Hoje" do Dashboard
    // (src/services/dashboard.ts) — não duplicar critério diferente aqui.
    const { data: rows } = await (admin as any)
      .from('sales')
      .select('id, total')
      .eq('company_id', companyId)
      .eq('sale_date', today)
      .not('status', 'in', '("cancelled","returned")') as { data: { id: number; total: number }[] | null }

    const salesRows = rows ?? []
    const revenue = salesRows.reduce((sum, r) => sum + Number(r.total ?? 0), 0)
    const orders = salesRows.length
    const avgTicket = orders > 0 ? revenue / orders : 0

    await sendPushNotification({
      companyId,
      roles: ['admin'],
      title: 'Santtorini',
      body: `${currency.format(revenue)} faturados hoje\n${orders} pedido${orders !== 1 ? 's' : ''} • Ticket médio ${currency.format(avgTicket)}`,
      url: '/',
    })

    results.push({ companyId, revenue, orders })
  }

  return NextResponse.json({ date: today, companies: results.length, results })
}
