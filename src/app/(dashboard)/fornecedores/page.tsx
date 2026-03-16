import { createClient } from '@/lib/supabase/server'
import Link from 'next/link'
import { Plus, Truck } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Card, CardHeader } from '@/components/ui/card'
import { Table, TableHeader, TableBody, TableRow, TableHead, TableCell } from '@/components/ui/table'
import { EmptyState } from '@/components/ui/empty-state'

async function getSuppliers() {
  const supabase = createClient()
  const { data } = await supabase
    .from('suppliers')
    .select('id, name, document, phone, city, state, active, created_at')
    .order('name', { ascending: true }) as unknown as { data: any[] | null, error: any }
  return data ?? []
}

function formatDoc(doc: string | null): string {
  if (!doc) return '—'
  const d = doc.replace(/\D/g, '')
  if (d.length === 11) return d.replace(/(\d{3})(\d{3})(\d{3})(\d{2})/, '$1.$2.$3-$4')
  if (d.length === 14) return d.replace(/(\d{2})(\d{3})(\d{3})(\d{4})(\d{2})/, '$1.$2.$3/$4-$5')
  return doc
}

export default async function FornecedoresPage() {
  const suppliers = await getSuppliers()

  return (
    <div className="space-y-5">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-lg font-semibold text-text-primary">Fornecedores</h2>
          <p className="text-sm text-text-muted">{suppliers.length} fornecedor{suppliers.length !== 1 ? 'es' : ''}</p>
        </div>
        <Link href="/fornecedores/novo">
          <Button size="sm"><Plus className="w-4 h-4" />Novo Fornecedor</Button>
        </Link>
      </div>

      <Card>
        {suppliers.length === 0 ? (
          <EmptyState icon={Truck} title="Nenhum fornecedor cadastrado" description="Cadastre o primeiro fornecedor." action={{ label: 'Novo fornecedor', onClick: () => {} }} />
        ) : (
          <>
            <CardHeader>
              <p className="text-xs text-text-muted">{suppliers.length} fornecedores</p>
            </CardHeader>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Nome</TableHead>
                  <TableHead>CPF/CNPJ</TableHead>
                  <TableHead>Telefone</TableHead>
                  <TableHead>Cidade / UF</TableHead>
                  <TableHead align="center">Status</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {suppliers.map((s) => (
                  <TableRow key={s.id}>
                    <TableCell>
                      <Link href={`/fornecedores/${s.id}`} className="text-sm font-medium hover:text-accent">{s.name}</Link>
                    </TableCell>
                    <TableCell muted><code className="text-xs">{formatDoc(s.document)}</code></TableCell>
                    <TableCell muted>{s.phone ?? '—'}</TableCell>
                    <TableCell muted>{s.city && s.state ? `${s.city} / ${s.state}` : s.city ?? '—'}</TableCell>
                    <TableCell align="center">
                      <Badge variant={s.active ? 'success' : 'default'} size="sm">{s.active ? 'Ativo' : 'Inativo'}</Badge>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </>
        )}
      </Card>
    </div>
  )
}
