import { requirePageRole } from '@/lib/auth/requirePageRole'
import { createAdminClient } from '@/lib/supabase/admin'
import { createClient } from '@/lib/supabase/server'
import Link from 'next/link'
import { ArrowLeft, BookOpen, Plus, Trash2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'

export const dynamic = 'force-dynamic'

export default async function ConfigColecoesPage() {
  await requirePageRole('admin')

  const supabase = createClient()
  const { data: { user: authUser } } = await supabase.auth.getUser()

  const admin = createAdminClient()
  const { data: userRow } = await (admin as any)
    .from('users')
    .select('company_id')
    .eq('id', authUser?.id)
    .single() as unknown as { data: { company_id: number } | null }

  const companyId = userRow?.company_id

  const { data } = companyId
    ? await (admin as any)
        .from('collections')
        .select('id, name, season, year')
        .eq('company_id', companyId)
        .order('year', { ascending: false })
        .order('name') as unknown as { data: { id: number; name: string; season: string | null; year: number | null }[] | null }
    : { data: null }

  const collections = data ?? []

  return (
    <div className="max-w-2xl space-y-6">
      <div className="flex items-center gap-3">
        <Link href="/configuracoes"><Button variant="ghost" size="icon"><ArrowLeft className="w-4 h-4" /></Button></Link>
        <div className="flex items-center gap-2">
          <BookOpen className="w-5 h-5 text-brand" />
          <div>
            <h2 className="text-lg font-semibold text-text-primary">Coleções</h2>
            <p className="text-sm text-text-muted">{collections.length} coleção(ões) cadastrada(s)</p>
          </div>
        </div>
      </div>

      <Card className="p-6 space-y-3">
        {collections.length === 0
          ? <p className="text-sm text-text-muted italic">Nenhuma coleção cadastrada ainda.</p>
          : collections.map(c => (
            <div key={c.id} className="flex items-center justify-between py-2 border-b border-border last:border-0">
              <div>
                <p className="text-sm font-medium text-text-primary">{c.name}</p>
                {(c.season || c.year) && <p className="text-xs text-text-muted">{[c.season, c.year].filter(Boolean).join(' · ')}</p>}
              </div>
            </div>
          ))
        }
        <p className="text-xs text-text-muted pt-2">Coleções são gerenciadas ao cadastrar produtos.</p>
      </Card>
    </div>
  )
}
