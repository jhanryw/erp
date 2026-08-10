'use client'

import { useMemo, useState } from 'react'
import { Card, CardHeader } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Badge } from '@/components/ui/badge'
import { formatCurrency, formatPercent } from '@/lib/utils/currency'
import {
  AlertTriangle,
  CheckCircle2,
  TrendingUp,
  Wallet,
  ShieldCheck,
  ArrowLeftRight,
} from 'lucide-react'
import {
  calculatePurchaseDecision,
  type PurchaseCalculatorInputs,
  type PurchaseCalculatorResult,
  type PurchaseDecisionType,
  type AttentionLevel,
} from '@/services/purchaseCalculator'
import { DEFAULT_MINIMUM_COVERAGE_RATIO } from '@/lib/constants/purchaseCalculator'

// ─── Estado do formulário (strings — permite digitar livremente, inclusive vazio) ──

type FormState = Record<Exclude<keyof PurchaseCalculatorInputs, 'supplierAcceptsMixed'>, string> & {
  supplierAcceptsMixed: boolean
}

const DEFAULT_FORM: FormState = {
  baseCost: '10000',
  cashDiscountPct: '5',
  installmentSurchargePct: '5',
  installmentsCount: '3',
  supplierAcceptsMixed: true,

  cashOnHand: '8000',
  expectedInflows30d: '35000',
  operatingCosts30d: '8307.81',
  existingInstallments30d: '7116.75',
  otherOutflows30d: '1000',
  minimumCashReserve: '4000',
  expectedStoreSales30d: '35000',

  markup: '3',
  expectedMerchandiseSales: '30000',
  expectedTurnoverDays: '90',

  minimumCoverageRatio: String(DEFAULT_MINIMUM_COVERAGE_RATIO),
}

function toNumber(raw: string): number {
  if (raw.trim() === '') return 0
  const n = Number(raw)
  return Number.isFinite(n) ? n : NaN
}

function toInputs(form: FormState): PurchaseCalculatorInputs {
  return {
    baseCost: toNumber(form.baseCost),
    cashDiscountPct: toNumber(form.cashDiscountPct),
    installmentSurchargePct: toNumber(form.installmentSurchargePct),
    installmentsCount: Math.trunc(toNumber(form.installmentsCount)),
    supplierAcceptsMixed: form.supplierAcceptsMixed,

    cashOnHand: toNumber(form.cashOnHand),
    expectedInflows30d: toNumber(form.expectedInflows30d),
    operatingCosts30d: toNumber(form.operatingCosts30d),
    existingInstallments30d: toNumber(form.existingInstallments30d),
    otherOutflows30d: toNumber(form.otherOutflows30d),
    minimumCashReserve: toNumber(form.minimumCashReserve),
    expectedStoreSales30d: toNumber(form.expectedStoreSales30d),

    markup: toNumber(form.markup),
    expectedMerchandiseSales: toNumber(form.expectedMerchandiseSales),
    expectedTurnoverDays: toNumber(form.expectedTurnoverDays),

    minimumCoverageRatio: toNumber(form.minimumCoverageRatio),
  }
}

// ─── UI helpers ─────────────────────────────────────────────────────────────────

const FIELD_LABELS: Partial<Record<keyof PurchaseCalculatorInputs, string>> = {
  baseCost: 'Valor base da mercadoria',
  cashDiscountPct: 'Desconto à vista (%)',
  installmentSurchargePct: 'Acréscimo a prazo (%)',
  installmentsCount: 'Número de parcelas',
  cashOnHand: 'Caixa atual',
  expectedInflows30d: 'Entradas previstas (30d)',
  operatingCosts30d: 'Custos operacionais (30d)',
  existingInstallments30d: 'Parcelas já contratadas (30d)',
  otherOutflows30d: 'Outros desembolsos (30d)',
  minimumCashReserve: 'Reserva mínima desejada',
  expectedStoreSales30d: 'Faturamento previsto da loja nos próximos 30 dias',
  markup: 'Markup médio usado na simulação',
  expectedMerchandiseSales: 'Venda total esperada desta mercadoria',
  expectedTurnoverDays: 'Prazo estimado para girar esta compra (dias)',
  minimumCoverageRatio: 'Folga mínima desejada',
}

const DECISION_LABELS: Record<PurchaseDecisionType, string> = {
  CASH: 'À vista',
  FINANCED: 'A prazo',
  MIXED: 'Misto',
  OVER_CAPACITY: 'Acima da capacidade',
}

const DECISION_BADGE: Record<PurchaseDecisionType, 'brand' | 'info' | 'success' | 'error'> = {
  CASH: 'brand',
  FINANCED: 'info',
  MIXED: 'success',
  OVER_CAPACITY: 'error',
}

const ATTENTION_BADGE: Record<AttentionLevel, 'success' | 'warning' | 'error'> = {
  ok: 'success',
  atencao: 'warning',
  critico: 'error',
}

function ratioLabel(ratio: number | null): string {
  if (ratio === null) return 'Sem parcelas atuais'
  return `${ratio.toFixed(2)}x`
}

function daysLabel(days: number): string {
  return `${Math.round(days)} dias`
}

function MetricCard({
  label,
  value,
  tone,
  sub,
}: {
  label: string
  value: string
  tone?: 'success' | 'error' | 'warning' | 'brand'
  sub?: string
}) {
  const toneClass =
    tone === 'success' ? 'text-success' : tone === 'error' ? 'text-error' : tone === 'warning' ? 'text-warning' : tone === 'brand' ? 'text-brand' : 'text-text-primary'
  return (
    <div className="card p-3.5">
      <p className="text-[11px] text-text-muted mb-1">{label}</p>
      <p className={`text-base font-bold ${toneClass}`}>{value}</p>
      {sub && <p className="text-[11px] text-text-muted mt-0.5">{sub}</p>}
    </div>
  )
}

// ─── Componente principal ───────────────────────────────────────────────────────

export function PurchaseCalculator() {
  const [form, setForm] = useState<FormState>(DEFAULT_FORM)

  function set(field: keyof FormState, value: string | boolean) {
    setForm((prev) => ({ ...prev, [field]: value as never }))
  }

  const inputs = useMemo(() => toInputs(form), [form])

  const outcome = useMemo(() => calculatePurchaseDecision(inputs), [inputs])

  return (
    <div className="grid grid-cols-1 xl:grid-cols-[420px_minmax(0,1fr)] gap-5 items-start">
      {/* ── Formulário ─────────────────────────────────────────────────────── */}
      <div className="space-y-4">
        {/* A. Compra */}
        <Card>
          <CardHeader>
            <h3 className="text-sm font-semibold text-text-primary">A. Compra</h3>
          </CardHeader>
          <div className="p-5 pt-4 space-y-3">
            <Input
              label={FIELD_LABELS.baseCost}
              type="number" min="0" step="0.01"
              value={form.baseCost}
              onChange={(e) => set('baseCost', e.target.value)}
              prefix="R$"
            />
            <div className="grid grid-cols-2 gap-3">
              <Input
                label={FIELD_LABELS.cashDiscountPct}
                type="number" min="0" step="0.1"
                value={form.cashDiscountPct}
                onChange={(e) => set('cashDiscountPct', e.target.value)}
                suffix="%"
              />
              <Input
                label={FIELD_LABELS.installmentSurchargePct}
                type="number" min="0" step="0.1"
                value={form.installmentSurchargePct}
                onChange={(e) => set('installmentSurchargePct', e.target.value)}
                suffix="%"
              />
            </div>
            <Input
              label={FIELD_LABELS.installmentsCount}
              type="number" min="1" step="1"
              value={form.installmentsCount}
              onChange={(e) => set('installmentsCount', e.target.value)}
            />
            <div>
              <label className="label-base">Fornecedor aceita modalidade mista?</label>
              <div className="flex gap-2">
                <button
                  type="button"
                  onClick={() => set('supplierAcceptsMixed', true)}
                  className={`flex-1 text-sm px-3 py-1.5 rounded-lg border font-medium transition-colors ${
                    form.supplierAcceptsMixed
                      ? 'bg-brand/15 border-brand/50 text-brand'
                      : 'bg-transparent border-border text-text-muted hover:border-text-muted'
                  }`}
                >
                  Sim
                </button>
                <button
                  type="button"
                  onClick={() => set('supplierAcceptsMixed', false)}
                  className={`flex-1 text-sm px-3 py-1.5 rounded-lg border font-medium transition-colors ${
                    !form.supplierAcceptsMixed
                      ? 'bg-bg-overlay border-border text-text-primary'
                      : 'bg-transparent border-border text-text-muted hover:border-text-muted'
                  }`}
                >
                  Não
                </button>
              </div>
              <p className="mt-1 text-xs text-text-muted">
                Modalidade mista: uma parte paga agora, o restante financiado.
              </p>
            </div>
          </div>
        </Card>

        {/* B. Caixa e obrigações */}
        <Card>
          <CardHeader>
            <h3 className="text-sm font-semibold text-text-primary">B. Caixa e obrigações (30 dias)</h3>
          </CardHeader>
          <div className="p-5 pt-4 space-y-3">
            <Input label={FIELD_LABELS.cashOnHand} type="number" min="0" step="0.01" prefix="R$"
              value={form.cashOnHand} onChange={(e) => set('cashOnHand', e.target.value)} />
            <Input label={FIELD_LABELS.expectedInflows30d} type="number" min="0" step="0.01" prefix="R$"
              value={form.expectedInflows30d} onChange={(e) => set('expectedInflows30d', e.target.value)} />
            <Input label={FIELD_LABELS.operatingCosts30d} type="number" min="0" step="0.01" prefix="R$"
              value={form.operatingCosts30d} onChange={(e) => set('operatingCosts30d', e.target.value)} />
            <Input label={FIELD_LABELS.existingInstallments30d} type="number" min="0" step="0.01" prefix="R$"
              value={form.existingInstallments30d} onChange={(e) => set('existingInstallments30d', e.target.value)} />
            <Input label={FIELD_LABELS.otherOutflows30d} type="number" min="0" step="0.01" prefix="R$"
              value={form.otherOutflows30d} onChange={(e) => set('otherOutflows30d', e.target.value)} />
            <Input label={FIELD_LABELS.minimumCashReserve} type="number" min="0" step="0.01" prefix="R$"
              value={form.minimumCashReserve} onChange={(e) => set('minimumCashReserve', e.target.value)}
              hint="Valor mínimo a preservar após as obrigações" />
            <Input label={FIELD_LABELS.expectedStoreSales30d} type="number" min="0" step="0.01" prefix="R$"
              value={form.expectedStoreSales30d} onChange={(e) => set('expectedStoreSales30d', e.target.value)}
              hint="Usado só para calcular a capacidade financeira mensal — não confundir com a venda desta mercadoria" />
          </div>
        </Card>

        {/* C. Mercadoria / operação */}
        <Card>
          <CardHeader>
            <h3 className="text-sm font-semibold text-text-primary">C. Mercadoria / operação</h3>
          </CardHeader>
          <div className="p-5 pt-4 space-y-3">
            <Input label={FIELD_LABELS.markup} type="number" min="0.01" step="0.1"
              value={form.markup} onChange={(e) => set('markup', e.target.value)}
              hint="Preço de venda ÷ custo — usado tanto para a operação da loja quanto para esta mercadoria" />
            <Input label={FIELD_LABELS.expectedMerchandiseSales} type="number" min="0" step="0.01" prefix="R$"
              value={form.expectedMerchandiseSales} onChange={(e) => set('expectedMerchandiseSales', e.target.value)}
              hint="Quanto este lote deve faturar ao longo do prazo de giro abaixo — não é faturamento de 30 dias" />
            <Input label={FIELD_LABELS.expectedTurnoverDays} type="number" min="1" step="1"
              value={form.expectedTurnoverDays} onChange={(e) => set('expectedTurnoverDays', e.target.value)} />
          </div>
        </Card>

        {/* D. Política de risco */}
        <Card>
          <CardHeader>
            <h3 className="text-sm font-semibold text-text-primary">D. Política de risco</h3>
          </CardHeader>
          <div className="p-5 pt-4">
            <Input label={FIELD_LABELS.minimumCoverageRatio} type="number" min="0.01" step="0.1"
              value={form.minimumCoverageRatio} onChange={(e) => set('minimumCoverageRatio', e.target.value)}
              suffix="x"
              hint="Geração operacional conservadora deve ser N vezes o total mensal das parcelas" />
          </div>
        </Card>
      </div>

      {/* ── Resultado ──────────────────────────────────────────────────────── */}
      <div className="space-y-4">
        {!outcome.valid ? (
          <Card>
            <div className="p-5 flex items-start gap-2 text-sm text-error">
              <AlertTriangle className="w-4 h-4 mt-0.5 shrink-0" />
              <div>
                <p className="font-semibold mb-1">Corrija os campos destacados</p>
                <ul className="list-disc list-inside space-y-0.5 text-xs">
                  {Object.entries(outcome.errors).map(([field, message]) => (
                    <li key={field}>
                      <strong>{FIELD_LABELS[field as keyof PurchaseCalculatorInputs] ?? field}</strong>: {message}
                    </li>
                  ))}
                </ul>
              </div>
            </div>
          </Card>
        ) : (
          <ResultPanel result={outcome.result} />
        )}
      </div>
    </div>
  )
}

// ─── Painel de resultado ─────────────────────────────────────────────────────────

function ResultPanel({ result: r }: { result: PurchaseCalculatorResult }) {
  const { decision, mixed } = r

  return (
    <div className="space-y-4">
      {/* Recomendação */}
      <Card>
        <div className={`p-5 border-l-4 ${
          decision.type === 'OVER_CAPACITY' ? 'border-error' :
          decision.type === 'CASH' ? 'border-brand' :
          decision.type === 'MIXED' ? 'border-success' : 'border-info'
        }`}>
          <div className="flex items-center gap-2 mb-2 flex-wrap">
            <Badge variant={DECISION_BADGE[decision.type]}>{DECISION_LABELS[decision.type]}</Badge>
            <Badge variant={ATTENTION_BADGE[decision.attentionLevel]} size="sm">
              {decision.attentionLevel === 'ok' ? 'Confortável' : decision.attentionLevel === 'atencao' ? 'Apertado' : 'Crítico'}
            </Badge>
          </div>
          <h3 className="text-base font-semibold text-text-primary mb-1.5">
            Recomendação: {decision.title}
          </h3>
          <p className="text-sm text-text-secondary leading-relaxed">{decision.justification}</p>
        </div>
      </Card>

      {/* Custo da compra */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
        <MetricCard label="Custo à vista" value={formatCurrency(r.cashCost)} />
        <MetricCard label="Custo a prazo" value={formatCurrency(r.financedCost)} />
        <MetricCard
          label="Custo do crédito/liquidez"
          value={formatCurrency(r.liquidityCost)}
          sub={r.liquidityCostPct !== null ? formatPercent(r.liquidityCostPct * 100, 1) : undefined}
        />
        <MetricCard label="Nova parcela" value={formatCurrency(r.monthlyInstallment)} />
      </div>

      {/* Caixa */}
      <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
        <MetricCard label="Caixa livre" value={formatCurrency(r.freeCashBeforePurchase)} />
        <MetricCard
          label="Caixa excedente protegido"
          value={formatCurrency(r.protectedExcessCash)}
          tone={r.protectedExcessCash >= 0 ? undefined : 'error'}
        />
        <MetricCard
          label="Caixa após pagamento à vista"
          value={formatCurrency(r.protectedCashAfterCashPurchase)}
          tone={r.protectedCashAfterCashPurchase >= 0 ? undefined : 'error'}
          sub="já descontada a reserva"
        />
      </div>

      {/* Geração operacional — capacidade financeira da LOJA em 30 dias.
          Nunca misturado com os números da mercadoria (bloco seguinte). */}
      <Card>
        <CardHeader>
          <h3 className="text-sm font-semibold text-text-primary flex items-center gap-2">
            <Wallet className="w-4 h-4 text-brand" /> Geração operacional projetada — 30 dias
          </h3>
        </CardHeader>
        <div className="p-5 pt-4 grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-3">
          <MetricCard label="Faturamento previsto (30d)" value={formatCurrency(r.inputs.expectedStoreSales30d)} />
          <MetricCard label="CMV estimado (30d)" value={formatCurrency(r.projectedStoreCOGS30d)} />
          <MetricCard label="Margem bruta estimada (30d)" value={formatCurrency(r.projectedStoreGrossMargin30d)} />
          <MetricCard label="Custos operacionais (30d)" value={formatCurrency(r.inputs.operatingCosts30d)} />
          <MetricCard
            label="Geração operacional projetada (30d)"
            value={formatCurrency(r.projectedOperatingGeneration30d)}
            tone={r.projectedOperatingGeneration30d >= 0 ? undefined : 'error'}
          />
          <MetricCard
            label="Capacidade adicional de parcela"
            value={formatCurrency(r.maximumNewInstallmentCapacityDisplay)}
            tone={r.existingInstallmentsExceedPolicy ? 'error' : undefined}
            sub={r.existingInstallmentsExceedPolicy ? 'parcelas atuais já excedem a política' : undefined}
          />
          <MetricCard label="Folga atual" value={ratioLabel(r.currentCoverageRatio)} />
          <MetricCard
            label="Folga pós-compra"
            value={ratioLabel(r.postPurchaseCoverageRatio)}
            tone={r.postPurchaseCoverageRatio !== null && r.postPurchaseCoverageRatio < r.inputs.minimumCoverageRatio ? 'error' : undefined}
          />
        </div>
      </Card>

      {/* Mercadoria — giro e autopagamento do LOTE comprado. Independente
          do faturamento da loja acima (horizontes de tempo diferentes). */}
      <Card>
        <CardHeader>
          <h3 className="text-sm font-semibold text-text-primary flex items-center gap-2">
            <TrendingUp className="w-4 h-4 text-info" /> Mercadoria
          </h3>
        </CardHeader>
        <div className="p-5 pt-4 grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-3">
          <MetricCard label="Venda esperada do lote" value={formatCurrency(r.inputs.expectedMerchandiseSales)} />
          <MetricCard label="Prazo de giro" value={daysLabel(r.inputs.expectedTurnoverDays)} />
          <MetricCard label="Venda média/dia" value={formatCurrency(r.expectedMerchandiseDailySales)} />
          <MetricCard label="CMV recuperado estimado (30d)" value={formatCurrency(r.expectedCOGSRecovered30d)} />
          <MetricCard
            label="Autopagamento estimado da parcela"
            value={r.installmentSelfPaymentRatio !== null ? `${r.installmentSelfPaymentRatio.toFixed(2)}x` : '—'}
            tone={r.installmentSelfPaymentRatio !== null ? (r.installmentSelfPaymentRatio >= 1 ? 'success' : 'warning') : undefined}
            sub={r.installmentSelfPaymentRatio !== null && r.installmentSelfPaymentRatio < 1 ? 'não é garantia' : undefined}
          />
        </div>
      </Card>

      {/* Modalidade mista */}
      {mixed.applicable && (
        <Card>
          <CardHeader>
            <h3 className="text-sm font-semibold text-text-primary flex items-center gap-2">
              <ArrowLeftRight className="w-4 h-4 text-brand" /> Modalidade mista
            </h3>
          </CardHeader>
          <div className="p-5 pt-4 grid grid-cols-2 sm:grid-cols-4 gap-3">
            <MetricCard label="Entrada segura sugerida" value={formatCurrency(mixed.safeCashContribution)} />
            <MetricCard label="Saldo financiado" value={formatCurrency(mixed.remainingBaseToFinance)} />
            <MetricCard label="Parcela mista" value={formatCurrency(mixed.monthlyInstallment)} />
            <MetricCard label="Custo total misto" value={formatCurrency(mixed.totalCost)} />
          </div>
          {!mixed.addsValue && (
            <p className="px-5 pb-4 text-xs text-text-muted">
              {mixed.safeCashContribution <= 0
                ? 'Não há caixa excedente protegido disponível — o misto não agrega valor sobre o financiamento total.'
                : 'O caixa excedente protegido cobre o custo à vista integralmente — na prática, equivale ao pagamento à vista.'}
            </p>
          )}
        </Card>
      )}

      {/* Comparador */}
      <ComparisonTable result={r} />

      <p className="text-xs text-text-muted leading-relaxed">
        Calculadora gerencial — todos os valores são manuais, sem integração com estoque, fornecedores,
        financeiro ou sugestão de compras. Não substitui análise de crédito nem parecer contábil.
      </p>
    </div>
  )
}

function ComparisonTable({ result: r }: { result: PurchaseCalculatorResult }) {
  const rows: { label: string; render: (c: (typeof r.comparison)[number]) => React.ReactNode }[] = [
    { label: 'Desembolso imediato', render: (c) => formatCurrency(c.immediateOutlay) },
    { label: 'Custo total', render: (c) => formatCurrency(c.totalCost) },
    { label: 'Parcela mensal', render: (c) => (c.monthlyInstallment !== null ? formatCurrency(c.monthlyInstallment) : '—') },
    { label: 'Caixa preservado hoje', render: (c) => formatCurrency(c.cashPreservedToday) },
    { label: 'Caixa após desembolso inicial', render: (c) => formatCurrency(c.cashAfterInitialOutlay) },
    { label: 'Folga das parcelas', render: (c) => ratioLabel(c.installmentSlack) },
    {
      label: 'Reserva preservada?',
      render: (c) =>
        c.reservePreserved ? (
          <span className="inline-flex items-center gap-1 text-success"><CheckCircle2 className="w-3.5 h-3.5" /> Sim</span>
        ) : (
          <span className="inline-flex items-center gap-1 text-error"><AlertTriangle className="w-3.5 h-3.5" /> Não</span>
        ),
    },
    { label: 'Custo financeiro adicional', render: (c) => formatCurrency(c.additionalFinancialCost) },
  ]

  return (
    <Card>
      <CardHeader>
        <h3 className="text-sm font-semibold text-text-primary flex items-center gap-2">
          <TrendingUp className="w-4 h-4 text-brand" /> Comparação
        </h3>
      </CardHeader>
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-border">
              <th className="text-left px-5 py-2.5 text-xs font-medium text-text-muted">Critério</th>
              {r.comparison.map((c) => (
                <th
                  key={c.key}
                  className={`text-right px-4 py-2.5 text-xs font-medium ${c.isRecommended ? 'text-brand' : 'text-text-muted'}`}
                >
                  <span className="inline-flex items-center gap-1 justify-end">
                    {c.label}
                    {c.isRecommended && <ShieldCheck className="w-3.5 h-3.5" />}
                  </span>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row.label} className="border-b border-border/50">
                <td className="px-5 py-2.5 text-text-muted text-xs">{row.label}</td>
                {r.comparison.map((c) => (
                  <td
                    key={c.key}
                    className={`px-4 py-2.5 text-right ${c.isRecommended ? 'bg-brand/5 font-semibold text-text-primary' : 'text-text-secondary'}`}
                  >
                    {row.render(c)}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Card>
  )
}
