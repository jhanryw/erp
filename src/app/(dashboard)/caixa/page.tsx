'use client'

import { useState, useEffect } from 'react'
import { toast } from 'sonner'
import { Wallet, ArrowDownLeft, ArrowUpRight, Receipt, X, Clock, Lock } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { formatCurrency } from '@/lib/utils/currency'

type CashSession = {
  id: number
  opened_at: string
  opening_amount_cash: number
}

type MovementType = 'sangria' | 'suprimento' | 'expense'
type PaymentMethod = 'cash' | 'pix' | 'credit_card' | 'debit_card'

const METHOD_LABELS: Record<PaymentMethod, string> = {
  cash:        'Dinheiro',
  pix:         'PIX',
  credit_card: 'Crédito',
  debit_card:  'Débito',
}

const MOVEMENT_LABELS: Record<MovementType, string> = {
  sangria:    'Sangria',
  suprimento: 'Suprimento',
  expense:    'Despesa',
}

export default function CaixaPage() {
  // undefined = carregando, null = fechado, objeto = aberto
  const [session, setSession]   = useState<CashSession | null | undefined>(undefined)
  const [loading, setLoading]   = useState(false)

  // Formulário de abertura
  const [openAmount, setOpenAmount] = useState('')
  const [openNotes,  setOpenNotes]  = useState('')

  // Formulário de movimento
  const [movType,   setMovType]   = useState<MovementType | null>(null)
  const [movAmount, setMovAmount] = useState('')
  const [movDesc,   setMovDesc]   = useState('')
  const [movMethod, setMovMethod] = useState<PaymentMethod>('cash')

  // Formulário de fechamento
  const [showClose,     setShowClose]     = useState(false)
  const [closeCounted,  setCloseCounted]  = useState('')
  const [closeNotes,    setCloseNotes]    = useState('')

  async function fetchSession() {
    try {
      const r    = await fetch('/api/caixa')
      const json = await r.json()
      setSession(json.session ?? null)
    } catch {
      setSession(null)
    }
  }

  useEffect(() => { fetchSession() }, [])

  async function handleOpen() {
    setLoading(true)
    try {
      const r    = await fetch('/api/caixa', {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({
          opening_amount_cash: parseFloat(openAmount) || 0,
          notes:               openNotes || null,
        }),
      })
      const json = await r.json()
      if (!r.ok) { toast.error(json.error ?? 'Erro ao abrir caixa'); return }
      toast.success('Caixa aberto!')
      setOpenAmount('')
      setOpenNotes('')
      await fetchSession()
    } catch {
      toast.error('Erro inesperado')
    } finally {
      setLoading(false)
    }
  }

  async function handleMovement() {
    if (!movType || !session) return
    setLoading(true)
    try {
      const r    = await fetch('/api/caixa/movimentos', {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({
          session_id:  session.id,
          type:        movType,
          amount:      parseFloat(movAmount) || 0,
          description: movDesc,
          method:      movType !== 'expense' ? 'cash' : movMethod,
        }),
      })
      const json = await r.json()
      if (!r.ok) { toast.error(json.error ?? 'Erro ao registrar movimento'); return }
      toast.success(`${MOVEMENT_LABELS[movType]} registrada!`)
      setMovType(null)
      setMovAmount('')
      setMovDesc('')
      setMovMethod('cash')
    } catch {
      toast.error('Erro inesperado')
    } finally {
      setLoading(false)
    }
  }

  async function handleClose() {
    if (!session) return
    setLoading(true)
    try {
      const r    = await fetch('/api/caixa/fechar', {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({
          session_id:   session.id,
          counted_cash: parseFloat(closeCounted) || 0,
          notes:        closeNotes || null,
        }),
      })
      const json = await r.json()
      if (!r.ok) { toast.error(json.error ?? 'Erro ao fechar caixa'); return }
      toast.success('Caixa fechado!')
      setShowClose(false)
      setCloseCounted('')
      setCloseNotes('')
      await fetchSession()
    } catch {
      toast.error('Erro inesperado')
    } finally {
      setLoading(false)
    }
  }

  // ─── Loading ──────────────────────────────────────────────────────────────────
  if (session === undefined) {
    return (
      <div className="max-w-lg mx-auto pt-16 text-center text-text-muted text-sm">
        Carregando...
      </div>
    )
  }

  // ─── Caixa fechado ────────────────────────────────────────────────────────────
  if (session === null) {
    return (
      <div className="max-w-lg mx-auto space-y-5 pb-10">
        <div className="flex items-center gap-3">
          <Wallet className="w-6 h-6 text-text-muted" />
          <h1 className="text-xl font-bold text-text-primary">Caixa</h1>
        </div>

        <div className="card p-5 space-y-4">
          <div className="flex items-center gap-2">
            <div className="w-2 h-2 rounded-full bg-error" />
            <span className="text-sm font-medium text-text-secondary">Caixa fechado</span>
          </div>

          <h2 className="text-base font-semibold text-text-primary">Abrir caixa</h2>

          <Input
            label="Fundo inicial (R$)"
            type="number"
            step="0.01"
            min="0"
            inputMode="decimal"
            placeholder="0,00"
            value={openAmount}
            onChange={(e) => setOpenAmount(e.target.value)}
          />
          <Input
            label="Observações (opcional)"
            placeholder="Ex.: início do turno da manhã"
            value={openNotes}
            onChange={(e) => setOpenNotes(e.target.value)}
          />

          <Button
            type="button"
            loading={loading}
            onClick={handleOpen}
            className="w-full h-11"
          >
            Abrir caixa
          </Button>
        </div>
      </div>
    )
  }

  // ─── Caixa aberto ─────────────────────────────────────────────────────────────
  const openedAt   = new Date(session.opened_at).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' })
  const openedDate = new Date(session.opened_at).toLocaleDateString('pt-BR')

  return (
    <div className="max-w-lg mx-auto space-y-5 pb-10">
      <div className="flex items-center gap-3">
        <Wallet className="w-6 h-6 text-success" />
        <h1 className="text-xl font-bold text-text-primary">Caixa</h1>
      </div>

      {/* ── Status do caixa ─────────────────────────────────────────────────── */}
      <div className="card p-5 space-y-3">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <div className="w-2 h-2 rounded-full bg-success animate-pulse" />
            <span className="text-sm font-semibold text-success">Caixa aberto</span>
          </div>
          <div className="flex items-center gap-1.5 text-xs text-text-muted">
            <Clock className="w-3.5 h-3.5" />
            {openedDate} às {openedAt}
          </div>
        </div>

        <div className="flex justify-between items-center pt-2 border-t border-border/50">
          <span className="text-sm text-text-secondary">Fundo inicial</span>
          <span className="text-sm font-semibold text-text-primary tabular-nums">
            {formatCurrency(session.opening_amount_cash)}
          </span>
        </div>
      </div>

      {/* ── Ações (só quando nenhum form está aberto) ───────────────────────── */}
      {!movType && !showClose && (
        <div className="grid grid-cols-2 gap-3">
          {([
            { type: 'sangria',    label: 'Sangria',    Icon: ArrowDownLeft, color: 'text-error'   },
            { type: 'suprimento', label: 'Suprimento', Icon: ArrowUpRight,  color: 'text-success' },
            { type: 'expense',    label: 'Despesa',    Icon: Receipt,       color: 'text-warning' },
          ] as { type: MovementType; label: string; Icon: React.ElementType; color: string }[]).map(({ type, label, Icon, color }) => (
            <button
              key={type}
              type="button"
              onClick={() => {
                setMovType(type)
                setMovAmount('')
                setMovDesc('')
                setMovMethod('cash')
              }}
              className="card p-4 flex flex-col items-center gap-2 hover:bg-bg-hover transition-colors active:scale-[0.97]"
            >
              <Icon className={`w-6 h-6 ${color}`} />
              <span className="text-sm font-medium text-text-primary">{label}</span>
            </button>
          ))}

          <button
            type="button"
            onClick={() => { setShowClose(true); setCloseCounted(''); setCloseNotes('') }}
            className="card p-4 flex flex-col items-center gap-2 border-error/20 hover:bg-error/5 hover:border-error/40 transition-colors active:scale-[0.97]"
          >
            <Lock className="w-6 h-6 text-error" />
            <span className="text-sm font-medium text-error">Fechar caixa</span>
          </button>
        </div>
      )}

      {/* ── Formulário de movimento ─────────────────────────────────────────── */}
      {movType && (
        <div className="card p-5 space-y-4">
          <div className="flex items-center justify-between">
            <h2 className="text-base font-semibold text-text-primary">
              {MOVEMENT_LABELS[movType]}
            </h2>
            <button
              type="button"
              onClick={() => setMovType(null)}
              className="w-8 h-8 flex items-center justify-center rounded-lg text-text-muted hover:text-text-primary hover:bg-bg-hover transition-colors"
            >
              <X className="w-4 h-4" />
            </button>
          </div>

          <Input
            label="Valor (R$)"
            type="number"
            step="0.01"
            min="0.01"
            inputMode="decimal"
            placeholder="0,00"
            value={movAmount}
            onChange={(e) => setMovAmount(e.target.value)}
          />

          <Input
            label="Descrição"
            placeholder={
              movType === 'sangria'    ? 'Ex.: retirada para troco' :
              movType === 'suprimento' ? 'Ex.: reforço de caixa'    :
              'Ex.: compra de material de escritório'
            }
            value={movDesc}
            onChange={(e) => setMovDesc(e.target.value)}
          />

          {movType === 'expense' && (
            <div className="space-y-1.5">
              <p className="text-xs font-medium text-text-secondary">Método de pagamento</p>
              <div className="grid grid-cols-2 gap-2">
                {(['cash', 'pix', 'credit_card', 'debit_card'] as PaymentMethod[]).map((m) => (
                  <button
                    key={m}
                    type="button"
                    onClick={() => setMovMethod(m)}
                    className={`py-2.5 rounded-lg border text-sm font-medium transition-colors ${
                      movMethod === m
                        ? 'bg-brand text-white border-brand'
                        : 'bg-bg-overlay border-border text-text-secondary hover:border-brand/50'
                    }`}
                  >
                    {METHOD_LABELS[m]}
                  </button>
                ))}
              </div>
            </div>
          )}

          {movType !== 'expense' && (
            <p className="text-xs text-text-muted">
              Sangria e suprimento são sempre em dinheiro físico.
            </p>
          )}

          <Button
            type="button"
            loading={loading}
            onClick={handleMovement}
            disabled={!movAmount || !movDesc}
            className="w-full h-11"
          >
            Registrar {MOVEMENT_LABELS[movType]}
          </Button>
        </div>
      )}

      {/* ── Formulário de fechamento ────────────────────────────────────────── */}
      {showClose && (
        <div className="card p-5 space-y-4 border-error/20">
          <div className="flex items-center justify-between">
            <h2 className="text-base font-semibold text-text-primary">Fechar caixa</h2>
            <button
              type="button"
              onClick={() => setShowClose(false)}
              className="w-8 h-8 flex items-center justify-center rounded-lg text-text-muted hover:text-text-primary hover:bg-bg-hover transition-colors"
            >
              <X className="w-4 h-4" />
            </button>
          </div>

          <Input
            label="Dinheiro contado em caixa (R$)"
            type="number"
            step="0.01"
            min="0"
            inputMode="decimal"
            placeholder="0,00"
            value={closeCounted}
            onChange={(e) => setCloseCounted(e.target.value)}
          />

          <Input
            label="Observações (opcional)"
            placeholder="Ex.: conferido com gerente"
            value={closeNotes}
            onChange={(e) => setCloseNotes(e.target.value)}
          />

          <Button
            type="button"
            variant="danger"
            loading={loading}
            onClick={handleClose}
            disabled={closeCounted === ''}
            className="w-full h-11"
          >
            Confirmar fechamento
          </Button>
        </div>
      )}
    </div>
  )
}
