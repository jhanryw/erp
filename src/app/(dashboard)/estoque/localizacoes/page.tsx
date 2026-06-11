'use client'

import { useState, useEffect } from 'react'
import { useForm } from 'react-hook-form'
import { zodResolver } from '@hookform/resolvers/zod'
import { z } from 'zod'
import { toast } from 'sonner'
import Link from 'next/link'
import { ArrowLeft, Plus, Edit, Trash2, Check, X } from 'lucide-react'
import { createClient } from '@/lib/supabase/client'
import { Input } from '@/components/ui/input'
import { Button } from '@/components/ui/button'
import { Card, CardHeader, CardContent } from '@/components/ui/card'

const createSchema = z.object({
  name:     z.string().min(2, 'Mínimo 2 caracteres').max(80),
  slug:     z.string().min(2).max(80).regex(/^[a-z0-9-]+$/, 'Só letras minúsculas, números e hífens'),
  priority: z.coerce.number().int().min(1).default(100),
})

type FormData = z.infer<typeof createSchema>

type Location = {
  id: number
  name: string
  slug: string
  is_main_store: boolean
  active: boolean
  priority: number
}

export default function LocalizacoesPage() {
  const supabase = createClient()
  const [locations, setLocations]   = useState<Location[]>([])
  const [loading, setLoading]       = useState(false)
  const [showForm, setShowForm]     = useState(false)
  const [editing, setEditing]       = useState<number | null>(null)
  const [editName, setEditName]     = useState('')
  const [editPriority, setEditPriority] = useState('100')

  const {
    register,
    handleSubmit,
    formState: { errors, isSubmitting },
    reset,
  } = useForm<FormData>({ resolver: zodResolver(createSchema) })

  useEffect(() => {
    fetchLocations()
  }, [])

  async function fetchLocations() {
    const { data } = await (supabase as any)
      .from('stock_locations')
      .select('id, name, slug, is_main_store, active, priority')
      .order('priority', { ascending: true })
    setLocations((data ?? []) as Location[])
  }

  async function onSubmit(data: FormData) {
    const res = await fetch('/api/estoque/localizacoes', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data),
    })

    if (!res.ok) {
      const err = await res.json()
      toast.error('Erro ao criar local', { description: err.error })
      return
    }

    toast.success('Local criado com sucesso')
    reset()
    setShowForm(false)
    fetchLocations()
  }

  async function toggleActive(id: number, active: boolean) {
    const res = await fetch(`/api/estoque/localizacoes/${id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ active: !active }),
    })

    if (!res.ok) {
      const err = await res.json()
      toast.error('Erro ao atualizar local', { description: err.error })
      return
    }

    toast.success(active ? 'Local desativado' : 'Local ativado')
    fetchLocations()
  }

  async function saveEdit(id: number) {
    const res = await fetch(`/api/estoque/localizacoes/${id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: editName,
        priority: parseInt(editPriority),
      }),
    })

    if (!res.ok) {
      const err = await res.json()
      toast.error('Erro ao atualizar local', { description: err.error })
      return
    }

    toast.success('Local atualizado')
    setEditing(null)
    fetchLocations()
  }

  return (
    <div className="space-y-5 max-w-2xl">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <Link href="/estoque">
            <Button variant="ghost" size="icon"><ArrowLeft className="w-4 h-4" /></Button>
          </Link>
          <h1 className="text-2xl font-semibold text-text-primary">Localizações de Estoque</h1>
        </div>
        <Button
          onClick={() => setShowForm(!showForm)}
          className="flex items-center gap-2"
        >
          <Plus className="w-4 h-4" />
          Novo Local
        </Button>
      </div>

      {/* Formulário de criação */}
      {showForm && (
        <Card className="border-brand/30 bg-brand/5">
          <CardHeader>
            <h3 className="text-sm font-semibold text-text-primary">Criar novo local</h3>
          </CardHeader>
          <CardContent>
            <form onSubmit={handleSubmit(onSubmit)} className="space-y-3">
              <Input
                label="Nome do local"
                placeholder="Ex: Loja Centro, Depósito, Consignado"
                error={errors.name?.message}
                {...register('name')}
              />

              <Input
                label="Slug (URL)"
                placeholder="Ex: loja-centro, deposito, consignado"
                hint="Apenas letras minúsculas, números e hífens"
                error={errors.slug?.message}
                {...register('slug')}
              />

              <Input
                label="Prioridade (ordem na tabela)"
                type="number"
                min="1"
                error={errors.priority?.message}
                {...register('priority')}
              />

              <div className="flex gap-2 pt-2">
                <Button type="submit" loading={isSubmitting} className="flex-1">
                  Criar Local
                </Button>
                <Button
                  type="button"
                  variant="secondary"
                  onClick={() => setShowForm(false)}
                  className="flex-1"
                >
                  Cancelar
                </Button>
              </div>
            </form>
          </CardContent>
        </Card>
      )}

      {/* Lista de locais */}
      <div className="space-y-2">
        {locations.length === 0 ? (
          <Card>
            <CardContent className="py-8 text-center text-text-muted">
              Nenhum local de estoque criado ainda.
            </CardContent>
          </Card>
        ) : (
          locations.map((loc) => (
            <Card key={loc.id}>
              <CardContent className="py-4">
                {editing === loc.id ? (
                  <div className="space-y-3">
                    <Input
                      label="Nome"
                      value={editName}
                      onChange={(e) => setEditName(e.target.value)}
                    />
                    <Input
                      label="Prioridade"
                      type="number"
                      min="1"
                      value={editPriority}
                      onChange={(e) => setEditPriority(e.target.value)}
                    />
                    <div className="flex gap-2">
                      <Button
                        size="sm"
                        onClick={() => saveEdit(loc.id)}
                        className="flex-1"
                      >
                        Salvar
                      </Button>
                      <Button
                        size="sm"
                        variant="secondary"
                        onClick={() => setEditing(null)}
                        className="flex-1"
                      >
                        Cancelar
                      </Button>
                    </div>
                  </div>
                ) : (
                  <div className="flex items-center justify-between">
                    <div className="flex-1">
                      <div className="flex items-center gap-2">
                        <h3 className="font-semibold text-text-primary">{loc.name}</h3>
                        {loc.is_main_store && (
                          <span className="text-xs bg-brand/15 text-brand px-2 py-0.5 rounded">
                            Principal
                          </span>
                        )}
                        {!loc.active && (
                          <span className="text-xs bg-text-muted/15 text-text-muted px-2 py-0.5 rounded">
                            Inativo
                          </span>
                        )}
                      </div>
                      <p className="text-xs text-text-muted mt-1">
                        <code>{loc.slug}</code> · Prioridade: {loc.priority}
                      </p>
                    </div>

                    <div className="flex gap-2">
                      {!loc.is_main_store && (
                        <>
                          <Button
                            size="sm"
                            variant="outline"
                            onClick={() => {
                              setEditing(loc.id)
                              setEditName(loc.name)
                              setEditPriority(loc.priority.toString())
                            }}
                          >
                            <Edit className="w-4 h-4" />
                          </Button>
                          <Button
                            size="sm"
                            variant={loc.active ? 'outline' : 'secondary'}
                            onClick={() => toggleActive(loc.id, loc.active)}
                          >
                            {loc.active ? (
                              <Check className="w-4 h-4 text-success" />
                            ) : (
                              <X className="w-4 h-4 text-warning" />
                            )}
                          </Button>
                        </>
                      )}
                    </div>
                  </div>
                )}
              </CardContent>
            </Card>
          ))
        )}
      </div>

      <div className="pt-4 border-t border-border text-sm text-text-muted space-y-1">
        <p><strong>💡 Dica:</strong> O local "Estoque Loja" é o principal — variações só aparecem para venda quando têm saldo lá.</p>
        <p><strong>📦</strong> Use "Transferir" na página de Estoque para mover quantidades entre locais.</p>
      </div>
    </div>
  )
}
