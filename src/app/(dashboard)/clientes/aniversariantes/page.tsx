import Link from 'next/link'
import { ArrowLeft, Cake, Phone, Gift } from 'lucide-react'
import { createAdminClient } from '@/lib/supabase/admin'
import { Card, CardHeader, CardContent } from '@/components/ui/card'
import { formatDate } from '@/lib/utils/date'

export const dynamic = 'force-dynamic'

type BirthdayCustomer = {
  id: number
  name: string
  phone: string | null
  birth_date: string
  city: string | null
}

async function getToday(): Promise<{ day: number; month: number }> {
  const now = new Date()
  return { day: now.getDate(), month: now.getMonth() + 1 }
}

async function getBirthdayCustomers(): Promise<{
  today: BirthdayCustomer[]
  thisMonth: BirthdayCustomer[]
}> {
  const supabase = createAdminClient()
  const { day, month } = await getToday()

  const { data, error } = await supabase
    .from('customers')
    .select('id, name, phone, birth_date, city')
    .not('birth_date', 'is', null)
    .eq('is_anonymous', false)
    .order('birth_date')

  if (error || !data) return { today: [], thisMonth: [] }

  const all = data as BirthdayCustomer[]

  const today = all.filter(c => {
    const d = new Date(c.birth_date + 'T12:00:00')
    return d.getDate() === day && d.getMonth() + 1 === month
  })

  const thisMonth = all.filter(c => {
    const d = new Date(c.birth_date + 'T12:00:00')
    return d.getMonth() + 1 === month && !(d.getDate() === day)
  })

  // Ordena pelo dia dentro do mês
  thisMonth.sort((a, b) => {
    const da = new Date(a.birth_date + 'T12:00:00').getDate()
    const db = new Date(b.birth_date + 'T12:00:00').getDate()
    return da - db
  })

  return { today, thisMonth }
}

function formatBirthDate(dateStr: string) {
  const d = new Date(dateStr + 'T12:00:00')
  return d.toLocaleDateString('pt-BR', { day: '2-digit', month: 'long' })
}

function formatWhatsApp(phone: string | null) {
  if (!phone) return null
  const digits = phone.replace(/\D/g, '')
  const number = digits.startsWith('55') ? digits : `55${digits}`
  return `https://wa.me/${number}`
}

const MONTH_NAMES = [
  'Janeiro', 'Fevereiro', 'Março', 'Abril', 'Maio', 'Junho',
  'Julho', 'Agosto', 'Setembro', 'Outubro', 'Novembro', 'Dezembro',
]

export default async function AniversariantesPage() {
  const { today, thisMonth } = await getBirthdayCustomers()
  const { month } = await getToday()
  const monthName = MONTH_NAMES[month - 1]

  return (
    <div className="space-y-6 max-w-3xl">
      {/* Header */}
      <div className="flex items-center gap-3">
        <Link href="/clientes" className="p-1.5 rounded-lg hover:bg-bg-hover transition-colors text-text-muted hover:text-text-primary">
          <ArrowLeft className="w-4 h-4" />
        </Link>
        <div>
          <h1 className="text-xl font-semibold text-text-primary flex items-center gap-2">
            <Cake className="w-5 h-5 text-brand" />
            Aniversariantes
          </h1>
          <p className="text-sm text-text-muted">
            {today.length + thisMonth.length} clientes com aniversário em {monthName}
          </p>
        </div>
      </div>

      {/* Hoje */}
      <Card>
        <CardHeader>
          <div className="flex items-center gap-2">
            <span className="text-base font-semibold text-text-primary">🎂 Hoje</span>
            {today.length > 0 && (
              <span className="text-xs font-semibold bg-brand/15 text-brand px-2 py-0.5 rounded-full">
                {today.length}
              </span>
            )}
          </div>
        </CardHeader>
        <CardContent>
          {today.length === 0 ? (
            <p className="text-sm text-text-muted italic">Nenhum aniversariante hoje.</p>
          ) : (
            <div className="space-y-2">
              {today.map(c => (
                <CustomerRow key={c.id} customer={c} highlight />
              ))}
            </div>
          )}
        </CardContent>
      </Card>

      {/* Resto do mês */}
      <Card>
        <CardHeader>
          <div className="flex items-center gap-2">
            <span className="text-base font-semibold text-text-primary">📅 Restante de {monthName}</span>
            {thisMonth.length > 0 && (
              <span className="text-xs font-semibold bg-bg-overlay text-text-muted px-2 py-0.5 rounded-full border border-border">
                {thisMonth.length}
              </span>
            )}
          </div>
        </CardHeader>
        <CardContent>
          {thisMonth.length === 0 ? (
            <p className="text-sm text-text-muted italic">Nenhum outro aniversariante este mês.</p>
          ) : (
            <div className="space-y-2">
              {thisMonth.map(c => (
                <CustomerRow key={c.id} customer={c} highlight={false} />
              ))}
            </div>
          )}
        </CardContent>
      </Card>

      {today.length === 0 && thisMonth.length === 0 && (
        <div className="text-center py-12 text-text-muted">
          <Cake className="w-10 h-10 mx-auto mb-3 opacity-30" />
          <p className="font-medium">Nenhum aniversariante em {monthName}</p>
          <p className="text-xs mt-1">Os clientes precisam ter data de nascimento cadastrada para aparecer aqui.</p>
        </div>
      )}
    </div>
  )
}

function CustomerRow({ customer, highlight }: { customer: BirthdayCustomer; highlight: boolean }) {
  const waLink = formatWhatsApp(customer.phone)

  return (
    <div className={`flex items-center justify-between gap-3 px-3 py-2.5 rounded-lg border transition-colors ${
      highlight
        ? 'bg-brand/5 border-brand/20'
        : 'bg-bg-overlay border-border hover:bg-bg-hover'
    }`}>
      <div className="flex items-center gap-3 min-w-0">
        <div className={`w-8 h-8 rounded-full flex items-center justify-center shrink-0 text-sm font-semibold ${
          highlight ? 'bg-brand/15 text-brand' : 'bg-bg-page text-text-muted border border-border'
        }`}>
          {new Date(customer.birth_date + 'T12:00:00').getDate()}
        </div>
        <div className="min-w-0">
          <Link
            href={`/clientes/${customer.id}`}
            className="text-sm font-medium text-text-primary hover:underline truncate block"
          >
            {customer.name}
          </Link>
          <p className="text-xs text-text-muted">
            {formatBirthDate(customer.birth_date)}
            {customer.city ? ` · ${customer.city}` : ''}
          </p>
        </div>
      </div>

      <div className="flex items-center gap-2 shrink-0">
        {customer.phone && (
          <span className="text-xs text-text-muted hidden sm:block font-mono">
            {customer.phone}
          </span>
        )}
        {waLink ? (
          <a
            href={waLink}
            target="_blank"
            rel="noopener noreferrer"
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-[#25D366]/10 hover:bg-[#25D366]/20 text-[#25D366] text-xs font-medium transition-colors border border-[#25D366]/20"
            title="Abrir WhatsApp"
          >
            <Phone className="w-3.5 h-3.5" />
            WhatsApp
          </a>
        ) : (
          <span className="text-xs text-text-disabled italic">sem telefone</span>
        )}
      </div>
    </div>
  )
}
