import { requirePageRole } from '@/lib/auth/requirePageRole'
import Link from 'next/link'
import { Plus, Truck } from 'lucide-react'

import { createAdminClient } from '@/lib/supabase/admin'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Card, CardHeader } from '@/components/ui/card'
import {
  Table,
  TableHeader,
  TableBody,
  TableRow,
  TableHead,
  TableCell,
} from '@/components/ui/table'
import { EmptyState } from '@/components/ui/empty-state'
import { DeleteSupplierButton } from './_components/delete-supplier-button'

export const dynamic = 'force-dynamic'

type SupplierRow = {
  id: number
  name: string
  document: string | null
  phone: string | null
  city: string | null
  state: string | null
  active: boolean
  created_at: string
}

type PerformanceMap = Record<number, { total_purchased_value: number; total_revenue: number }>

async function getSuppliers(): Promise<SupplierRow[]> {
  const supabase = createAdminClient()

  const { data, error } = await supabase
    .from('suppliers')
    .select('id, name, document, phone, city, state, active, created_at')
    .order('name', { ascending: true })

  if (error) {
    console.error('Erro ao listar fornecedores:', error.message)
    return []
  }

  return (data ?? []) as SupplierRow[]
}

async function getPerformance(): Promise<PerformanceMap> {
  const supabase = createAdminClient()

  const { data, error } = await supabase
    .from('mv_supplier_performance')
    .select('supplier_id, total_purchased_value, total_revenue')

  if (error) {
    console.error('Erro ao buscar performance de fornecedores:', error.message)
    return {}
  }

  return Object.fromEntries(
    (data ?? []).map((r: { supplier_id: number; total_purchased_value: number; total_revenue: number }) => [
      r.supplier_id,
      { total_purchased_value: r.total_purchased_value ?? 0, total_revenue: r.total_revenue ?? 0 },
    ])
  )
}

function fmtBrl(value: number): string {
  return value.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' })
}

function formatDoc(doc: string | null): string {
  if (!doc) return '—'

  const d = doc.replace(/\D/g, '')

  if (d.length === 11) {
    return d.replace(/(\d{3})(\d{3})(\d{3})(\d{2})/, '$1.$2.$3-$4')
  }

  if (d.length === 14) {
    return d.replace(/(\d{2})(\d{3})(\d{3})(\d{4})(\d{2})/, '$1.$2.$3/$4-$5')
  }

  return doc
}

export default async function FornecedoresPage() {
  await requirePageRole('gerente')
  const [suppliers, performance] = await Promise.all([getSuppliers(), getPerformance()])

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Fornecedores</h1>
          <p className="text-sm text-muted-foreground">
            {suppliers.length} fornecedor{suppliers.length !== 1 ? 'es' : ''}
          </p>
        </div>

        <Link href="/fornecedores/novo">
          <Button>
            <Plus className="mr-2 h-4 w-4" />
            Novo Fornecedor
          </Button>
        </Link>
      </div>

      {suppliers.length === 0 ? (
        <EmptyState
          icon={<Truck className="h-4 w-4" />}
          title="Nenhum fornecedor cadastrado"
          description="Cadastre o primeiro fornecedor."
          action={{ label: 'Novo fornecedor', href: '/fornecedores/novo' }}
      />
      ) : (
        <Card>
          <CardHeader className="text-sm text-muted-foreground">
            {suppliers.length} fornecedores
          </CardHeader>

          <div className="overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Nome</TableHead>
                  <TableHead>CPF/CNPJ</TableHead>
                  <TableHead>Telefone</TableHead>
                  <TableHead>Cidade / UF</TableHead>
                  <TableHead className="text-right">Valor Gasto</TableHead>
                  <TableHead className="text-right">Faturamento</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead className="text-right">Ações</TableHead>
                </TableRow>
              </TableHeader>

              <TableBody>
                {suppliers.map((s) => {
                  const perf = performance[s.id]
                  return (
                    <TableRow key={s.id}>
                      <TableCell className="font-medium">
                        <Link href={`/fornecedores/${s.id}`} className="hover:underline">
                          {s.name}
                        </Link>
                      </TableCell>
                      <TableCell>{formatDoc(s.document)}</TableCell>
                      <TableCell>{s.phone ?? '—'}</TableCell>
                      <TableCell>
                        {s.city && s.state ? `${s.city} / ${s.state}` : s.city ?? '—'}
                      </TableCell>
                      <TableCell className="text-right tabular-nums">
                        {perf ? fmtBrl(perf.total_purchased_value) : '—'}
                      </TableCell>
                      <TableCell className="text-right tabular-nums">
                        {perf ? fmtBrl(perf.total_revenue) : '—'}
                      </TableCell>
                      <TableCell>
                        <Badge variant={s.active ? 'default' : 'secondary'}>
                          {s.active ? 'Ativo' : 'Inativo'}
                        </Badge>
                      </TableCell>
                      <TableCell className="text-right">
                        <div className="flex justify-end gap-2">
                          <Link href={`/fornecedores/${s.id}/editar`}>
                            <Button variant="outline" size="sm">
                              Editar
                            </Button>
                          </Link>
                          <DeleteSupplierButton id={s.id} />
                        </div>
                      </TableCell>
                    </TableRow>
                  )
                })}
              </TableBody>
            </Table>
          </div>
        </Card>
      )}
    </div>
  )
}