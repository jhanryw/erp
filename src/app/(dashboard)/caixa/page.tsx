'use client'

import { useState, useEffect } from 'react'
import { toast } from 'sonner'
import { Wallet, ArrowDownLeft, ArrowUpRight, Receipt, X, Clock, Lock, History } from 'lucide-react'
import Link from 'next/link'
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
  const [showClose,       setShowClose]       = useState(false)
  const [closeCounted,    setCloseCounted]    = useState('')
  const [closeNotes,      setCloseNotes]      = useState('')
  const [expectedCash,    setExpectedCash]    = useState<number | null>(null)
  const [loadingPreview,  setLoadingPreview]  = useState(false)

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

  async function openCloseForm() {
    if (!session) return
    setLoadingPreview(true)
    setExpectedCash(null)
    setCloseCounted('')
    setCloseNotes('')
    try {
      const r    = await fetch(`/api/caixa/fechar?session_id=${session.id}`)
      const json = await r.json()
      if (r.ok && typeof json.expected_cash === 'number') {
        setExpectedCash(json.expected_cash)
      }
    } catch {
      // preview não-fatal: mostra o form sem o valor esperado
    } finally {
      setLoadingPreview(false)
      setShowClose(true)
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
      setExpectedCash(null)
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
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-3">
            <Wallet className="w-6 h-6 text-text-muted" />
            <h1 className="text-xl font-bold text-text-primary">Caixa</h1>
          </div>
          <Link href="/caixa/historico">
            <Button variant="secondary" size="sm">
              <History className="w-3.5 h-3.5" />
              Histórico
            </Button>
          </Link>
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
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <Wallet className="w-6 h-6 text-success" />
          <h1 className="text-xl font-bold text-text-primary">Caixa</h1>
        </div>
        <Link href="/caixa/historico">
          <Button variant="secondary" size="sm">
            <History className="w-3.5 h-3.5" />
            Histórico
          </Button>
        </Link>
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
            onClick={openCloseForm}
            disabled={loadingPreview}
            className="card p-4 flex flex-col items-center gap-2 border-error/20 hover:bg-error/5 hover:border-error/40 transition-colors active:scale-[0.97] disabled:opacity-60"
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
              onClick={() => { setShowClose(false); setExpectedCash(null) }}
              className="w-8 h-8 flex items-center justify-center rounded-lg text-text-muted hover:text-text-primary hover:bg-bg-hover transition-colors"
            >
              <X className="w-4 h-4" />
            </button>
          </div>

          {/* Valor esperado calculado pelo sistema */}
          {expectedCash !== null && (
            <div className="rounded-xl bg-bg-overlay border border-border p-4 space-y-1">
              <p className="text-xs text-text-muted">Dinheiro esperado no caixa</p>
              <p className="text-2xl font-bold tabular-nums text-text-primary">
                {formatCurrency(expectedCash)}
              </p>
              <p className="text-xs text-text-muted">
                Fundo inicial + dinheiro recebido − troco pago − sangrias + suprimentos
              </p>
            </div>
          )}

          <Input
            label={
              expectedCash !== null
                ? `Dinheiro contado fisicamente (esperado: ${formatCurrency(expectedCash)})`
                : 'Dinheiro contado em caixa (R$)'
            }
            type="number"
            step="0.01"
            min="0"
            inputMode="decimal"
            placeholder="0,00"
            value={closeCounted}
            onChange={(e) => setCloseCounted(e.target.value)}
          />

          {/* Diferença em tempo real */}
          {expectedCash !== null && closeCounted !== '' && (
            (() => {
              const counted = parseFloat(closeCounted) || 0
              const diff    = Math.round((counted - expectedCash) * 100) / 100
              const ok      = Math.abs(diff) < 0.01
              return (
                <div className={`rounded-lg p-3 text-sm font-medium ${
                  ok ? 'bg-success/10 text-success' : 'bg-error/10 text-error'
                }`}>
                  {ok
                    ? '✓ Valores conferem — caixa pode ser fechado'
                    : 'Atenção: valor contado não confere com o esperado pelo sistema'}
                </div>
              )
            })()
          )}

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
