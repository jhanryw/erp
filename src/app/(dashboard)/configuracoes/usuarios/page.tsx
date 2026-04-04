import { requirePageRole } from '@/lib/auth/requirePageRole'
import { createAdminClient } from '@/lib/supabase/admin'
import { createClient } from '@/lib/supabase/server'
import Link from 'next/link'
import { ArrowLeft, Users } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import { Table, TableHeader, TableBody, TableRow, TableHead, TableCell } from '@/components/ui/table'

export const dynamic = 'force-dynamic'

const ROLE_LABELS: Record<string, string> = {
  admin:   'Administrador',
  gerente: 'Gerente',
  usuario: 'Usuário',
}

export default async function ConfigUsuariosPage() {
  await requirePageRole('admin')

  const supabase = createClient()
  const { data: { user: authUser } } = await supabase.auth.getUser()

  const admin = createAdminClient()
  const { data } = await (admin as any)
    .from('users')
    .select('id, name, role, company_id')
    .order('name') as unknown as { data: { id: string; name: string | null; role: string | null; company_id: number | null }[] | null }

  const companyId = (data ?? []).find(u => u.id === authUser?.id)?.company_id
  const users = (data ?? []).filter(u => u.company_id === companyId)

  return (
    <div className="max-w-3xl space-y-6">
      <div className="flex items-center gap-3">
        <Link href="/configuracoes"><Button variant="ghost" size="icon"><ArrowLeft className="w-4 h-4" /></Button></Link>
        <div className="flex items-center gap-2">
          <Users className="w-5 h-5 text-brand" />
          <div>
            <h2 className="text-lg font-semibold text-text-primary">Usuários</h2>
            <p className="text-sm text-text-muted">{users.length} usuário{users.length !== 1 ? 's' : ''} na empresa</p>
          </div>
        </div>
      </div>

      <Card>
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Nome</TableHead>
              <TableHead>Perfil</TableHead>
              <TableHead>ID</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {users.map(u => (
              <TableRow key={u.id}>
                <TableCell className="font-medium">{u.name ?? '—'}{u.id === authUser?.id ? <span className="ml-2 text-xs text-text-muted">(você)</span> : null}</TableCell>
                <TableCell>{ROLE_LABELS[u.role ?? ''] ?? u.role ?? '—'}</TableCell>
                <TableCell><code className="text-xs text-text-muted">{u.id}</code></TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </Card>

      <p className="text-xs text-text-muted">Para adicionar ou remover usuários, acesse o painel de autenticação do Supabase.</p>
    </div>
  )
}
