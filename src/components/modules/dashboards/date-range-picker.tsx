'use client'

import { useRouter, usePathname } from 'next/navigation'
import { useState } from 'react'
import { CalendarDays, ChevronDown } from 'lucide-react'

export type RangePreset = 'today' | 'yesterday' | '7d' | '30d' | '90d' | 'year'

interface DateRangePickerProps {
  activeRange: RangePreset | 'custom'
  dateFrom?: string
  dateTo?: string
}

const PRESETS: { value: RangePreset; label: string }[] = [
  { value: 'today',     label: 'Hoje' },
  { value: 'yesterday', label: 'Ontem' },
  { value: '7d',        label: '7 dias' },
  { value: '30d',       label: '30 dias' },
  { value: '90d',       label: '90 dias' },
  { value: 'year',      label: 'Este ano' },
]

export function DateRangePicker({ activeRange, dateFrom, dateTo }: DateRangePickerProps) {
  const router   = useRouter()
  const pathname = usePathname()
  const [customOpen, setCustomOpen] = useState(false)
  const [customFrom, setCustomFrom] = useState(dateFrom ?? '')
  const [customTo,   setCustomTo]   = useState(dateTo   ?? '')

  function selectPreset(preset: RangePreset) {
    router.push(`${pathname}?range=${preset}`)
    setCustomOpen(false)
  }

  function applyCustom() {
    if (!customFrom || !customTo) return
    if (customFrom > customTo) return
    router.push(`${pathname}?range=custom&from=${customFrom}&to=${customTo}`)
    setCustomOpen(false)
  }

  const activeLabel = PRESETS.find(p => p.value === activeRange)?.label
    ?? (activeRange === 'custom' && dateFrom && dateTo
      ? `${formatLabel(dateFrom)} – ${formatLabel(dateTo)}`
      : '30 dias')

  return (
    <div className="relative">
      {/* Preset buttons — horizontal scroll on mobile */}
      <div className="flex items-center gap-2 flex-wrap">
        {PRESETS.map((preset) => (
          <button
            key={preset.value}
            onClick={() => selectPreset(preset.value)}
            className={`px-3 py-1.5 rounded-lg text-sm font-medium transition-colors whitespace-nowrap ${
              activeRange === preset.value
                ? 'bg-brand text-white'
                : 'bg-bg-subtle text-text-secondary hover:bg-bg-hover border border-border'
            }`}
          >
            {preset.label}
          </button>
        ))}

        {/* Custom range button */}
        <button
          onClick={() => setCustomOpen(v => !v)}
          className={`flex items-center gap-1 px-3 py-1.5 rounded-lg text-sm font-medium transition-colors whitespace-nowrap ${
            activeRange === 'custom'
              ? 'bg-brand text-white'
              : 'bg-bg-subtle text-text-secondary hover:bg-bg-hover border border-border'
          }`}
        >
          <CalendarDays className="h-3.5 w-3.5" />
          {activeRange === 'custom' ? activeLabel : 'Período'}
          <ChevronDown className={`h-3 w-3 transition-transform ${customOpen ? 'rotate-180' : ''}`} />
        </button>
      </div>

      {/* Custom date dropdown */}
      {customOpen && (
        <div className="absolute right-0 top-full mt-2 z-50 w-72 rounded-xl border border-border bg-bg-card shadow-xl p-4 space-y-3">
          <p className="text-sm font-medium text-text-primary">Período personalizado</p>

          <div className="grid grid-cols-2 gap-2">
            <div className="space-y-1">
              <label className="text-xs text-text-muted">De</label>
              <input
                type="date"
                value={customFrom}
                onChange={e => setCustomFrom(e.target.value)}
                max={customTo || undefined}
                className="w-full rounded-lg border border-border bg-bg-input px-2 py-1.5 text-sm text-text-primary focus:outline-none focus:ring-2 focus:ring-brand/40"
              />
            </div>
            <div className="space-y-1">
              <label className="text-xs text-text-muted">Até</label>
              <input
                type="date"
                value={customTo}
                onChange={e => setCustomTo(e.target.value)}
                min={customFrom || undefined}
                className="w-full rounded-lg border border-border bg-bg-input px-2 py-1.5 text-sm text-text-primary focus:outline-none focus:ring-2 focus:ring-brand/40"
              />
            </div>
          </div>

          <div className="flex gap-2 pt-1">
            <button
              onClick={() => setCustomOpen(false)}
              className="flex-1 px-3 py-1.5 rounded-lg text-sm border border-border text-text-secondary hover:bg-bg-hover transition-colors"
            >
              Cancelar
            </button>
            <button
              onClick={applyCustom}
              disabled={!customFrom || !customTo || customFrom > customTo}
              className="flex-1 px-3 py-1.5 rounded-lg text-sm bg-brand text-white font-medium disabled:opacity-40 hover:bg-brand/90 transition-colors"
            >
              Aplicar
            </button>
          </div>
        </div>
      )}
    </div>
  )
}

function formatLabel(iso: string): string {
  const [y, m, d] = iso.split('-')
  return `${d}/${m}/${y}`
}
