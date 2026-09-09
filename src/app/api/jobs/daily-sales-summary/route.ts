export const dynamic = 'force-dynamic'

import { NextResponse } from 'next/server'
import { createAdminClient } from '@/lib/supabase/admin'
import { brazilDate } from '@/lib/utils/date'
import { getTodayRevenue } from '@/lib/analytics/todayRevenue'
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
    // Claim atômico ANTES de enviar — garante no máximo 1 resumo por empresa
    // por dia, mesmo que este endpoint seja chamado mais de uma vez (pg_cron
    // disparando em duplicidade, sobreposição com o cron externo durante a
    // migração, retry manual). ignoreDuplicates: já existe linha → pula envio.
    const { data: claimed } = await (admin as any)
      .from('daily_summary_notifications')
      .upsert({ company_id: companyId, summary_date: today }, { onConflict: 'company_id,summary_date', ignoreDuplicates: true })
      .select('company_id')

    if (!claimed?.length) continue

    // Mesma regra de negócio EXATA do card "Faturamento Hoje" do Dashboard —
    // fonte única em src/lib/analytics/todayRevenue.ts.
    const { revenue, orders, avgTicket } = await getTodayRevenue(companyId)

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
