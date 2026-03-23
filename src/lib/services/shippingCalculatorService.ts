import { createAdminClient } from '@/lib/supabase/admin'
import { calculateDistance } from './geocodingService'
import type { ShippingCalculationResult } from '@/types/shipping.types'

export async function calculateShipping(
  latitude: number,
  longitude: number,
  cep: string,
  city: string,
  neighborhood: string,
  orderTotal: number,
  deliveryMode: 'pickup' | 'delivery' = 'delivery'
): Promise<ShippingCalculationResult | { error: string }> {
  try {
    const admin = createAdminClient()

    // 1. Get origin
    const { data: origins } = await admin
      .from('shipping_origins')
      .select('*')
      .eq('is_active', true)
      .limit(1)

    if (!origins || origins.length === 0) {
      return { error: 'Origem de envio não configurada' }
    }

    const origin = origins[0]

    // 2. Calculate distance
    const distance = calculateDistance(origin.latitude, origin.longitude, latitude, longitude)

    // 3. Find matching zone/rule by priority: CEP → Neighborhood → Distance
    const { data: zones } = await admin
      .from('shipping_zones')
      .select('*, shipping_rules(*)')
      .eq('is_active', true)
      .order('priority', { ascending: true })

    if (!zones) {
      return { error: 'Zonas de envio não configuradas' }
    }

    let matchedRule: any = null
    let matchedZone: any = null

    // Try by CEP range
    for (const zone of zones) {
      const ranges = (zone.cep_ranges_json as Array<{ min: string; max: string }> | null) || []
      for (const range of ranges) {
        const cepisInRange = cep >= range.min && cep <= range.max
        if (cepisInRange) {
          const rules = Array.isArray(zone.shipping_rules)
            ? zone.shipping_rules
            : zone.shipping_rules
              ? [zone.shipping_rules]
              : []
          const rule = rules.find((r: any) => r.is_active)
          if (rule) {
            matchedRule = rule
            matchedZone = zone
            break
          }
        }
      }
      if (matchedRule) break
    }

    // Try by neighborhood + city
    if (!matchedRule) {
      for (const zone of zones) {
        const neighborhoods = (zone.neighborhoods_json as string[] | null) || []
        const matches =
          neighborhoods.some((n: string) => n.toLowerCase() === neighborhood.toLowerCase()) &&
          zone.city?.toLowerCase() === city.toLowerCase()

        if (matches) {
          const rules = Array.isArray(zone.shipping_rules)
            ? zone.shipping_rules
            : zone.shipping_rules
              ? [zone.shipping_rules]
              : []
          const rule = rules.find((r: any) => r.is_active)
          if (rule) {
            matchedRule = rule
            matchedZone = zone
            break
          }
        }
      }
    }

    // Try by distance
    if (!matchedRule) {
      for (const zone of zones) {
        const minKm = zone.min_km || 0
        const maxKm = zone.max_km || 999
        if (distance >= minKm && distance <= maxKm) {
          const rules = Array.isArray(zone.shipping_rules)
            ? zone.shipping_rules
            : zone.shipping_rules
              ? [zone.shipping_rules]
              : []
          const rule = rules.find((r: any) => r.is_active && r.allow_delivery)
          if (rule) {
            matchedRule = rule
            matchedZone = zone
            break
          }
        }
      }
    }

    if (!matchedRule) {
      return { error: `Não entregamos em ${city} / ${neighborhood} no momento. Retirada disponível.` }
    }

    // 4. Calculate prices
    let clientPrice = matchedRule.client_price
    const internalCost = matchedRule.internal_cost

    let freeShippingApplied = false
    if (matchedRule.free_shipping_min_order && orderTotal >= matchedRule.free_shipping_min_order) {
      clientPrice = 0
      freeShippingApplied = true
    }

    if (matchedRule.min_order_to_enable && orderTotal < matchedRule.min_order_to_enable) {
      return { error: `Entrega mínima de R$ ${matchedRule.min_order_to_enable.toFixed(2)} nesta região` }
    }

    const subsidy = internalCost - clientPrice

    return {
      delivery_mode: 'delivery',
      zone_id: matchedZone.id,
      rule_id: matchedRule.id,
      distance_km: Math.round(distance * 100) / 100,
      client_price: clientPrice,
      internal_cost: internalCost,
      estimated_hours: matchedRule.estimated_hours,
      subsidy,
      free_shipping_applied: freeShippingApplied,
      reason: `Zona: ${matchedZone.name} | ${Math.round(distance)}km`,
    }
  } catch (error) {
    console.error('[Shipping Calculator] Erro:', error)
    return { error: 'Erro ao calcular frete' }
  }
}
