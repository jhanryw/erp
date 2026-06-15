'use server'

import { createAdminClient } from '@/lib/supabase/admin'

export type SimulationInputs = {
  sale_price: number
  cost: number
  gross_profit: number
  gross_margin_pct: number
  annual_revenue: number
  uf_destino: string
  icms_rate_pct: number
}

export type RegimeFull = {
  elegivel?: true
  das?: number
  das_rate_pct?: number
  pis?: number
  cofins?: number
  irpj_csll: number
  icms: number
  total_tax: number
  effective_rate_pct: number
  net_revenue: number
  net_profit: number
  net_margin_pct: number
  nota: string
}

export type RegimeIneligible = {
  elegivel: false
  motivo: string
}

export type SimulationResult = {
  inputs: SimulationInputs
  simples_nacional: RegimeFull | RegimeIneligible
  lucro_presumido: RegimeFull
  lucro_real: RegimeFull
}

export async function simulateTaxes(
  salePrice: number,
  cost: number,
  annualRevenue: number,
  ufDestino: string,
): Promise<{ data: SimulationResult | null; error: string | null }> {
  try {
    const admin = createAdminClient()
    const { data, error } = await (admin as any).rpc('rpc_simulate_taxes', {
      p_sale_price:     salePrice,
      p_cost:           cost,
      p_annual_revenue: annualRevenue,
      p_uf_destino:     ufDestino,
    })
    if (error) return { data: null, error: error.message }
    return { data: data as SimulationResult, error: null }
  } catch (e) {
    return { data: null, error: e instanceof Error ? e.message : 'Erro desconhecido.' }
  }
}
