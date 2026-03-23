export type DeliveryMode = 'pickup' | 'delivery'

export type ShipmentStatus =
  | 'aguardando_confirmacao'
  | 'aguardando_separacao'
  | 'pronto_envio'
  | 'aguardando_motoboy'
  | 'saiu_entrega'
  | 'entregue'
  | 'tentativa_entrega'
  | 'nao_entregue'
  | 'aguardando_retirada'
  | 'retirado'
  | 'cancelado'

export interface ShippingOrigin {
  id: number
  name: string
  cep: string
  street: string
  number?: string
  complement?: string
  neighborhood: string
  city: string
  state: string
  latitude: number
  longitude: number
  is_active: boolean
  created_at?: string
  updated_at?: string
}

export interface ShippingZone {
  id: number
  name: string
  description?: string
  state: string
  city?: string
  neighborhoods_json: string[] | null
  cep_ranges_json: Array<{ min: string; max: string }> | null
  min_km?: number
  max_km?: number
  color: string
  priority: number
  is_active: boolean
  created_at?: string
  updated_at?: string
}

export interface ShippingRule {
  id: number
  zone_id: number
  rule_type: string
  client_price: number
  internal_cost: number
  estimated_hours: number
  free_shipping_min_order?: number
  min_order_to_enable?: number
  allow_pickup: boolean
  allow_delivery: boolean
  is_active: boolean
  created_at?: string
  updated_at?: string
}

export interface CustomerAddress {
  id: number
  customer_id: number
  cep: string
  street: string
  number: string
  complement?: string
  neighborhood: string
  city: string
  state: string
  reference?: string
  latitude?: number
  longitude?: number
  geocode_source?: string
  is_validated: boolean
  is_default: boolean
  created_at?: string
  updated_at?: string
}

export interface Shipment {
  id: number
  order_id: number
  customer_id: number
  address_id?: number
  origin_id: number
  zone_id?: number
  rule_id?: number
  delivery_mode: DeliveryMode
  distance_km?: number
  client_shipping_price?: number
  internal_shipping_cost_estimated?: number
  internal_shipping_cost_real?: number
  shipping_subsidy?: number
  status: ShipmentStatus
  courier_name?: string
  courier_phone?: string
  dispatched_at?: string
  delivered_at?: string
  pickup_at?: string
  notes?: string
  proof_url?: string
  created_at?: string
  updated_at?: string
}

export interface ShipmentEvent {
  id: number
  shipment_id: number
  status: string
  description?: string
  created_by?: string
  created_at: string
}

export interface ShippingCalculationResult {
  delivery_mode: DeliveryMode
  zone_id: number
  rule_id: number
  distance_km: number
  client_price: number
  internal_cost: number
  estimated_hours: number
  subsidy: number
  free_shipping_applied: boolean
  reason: string
}

export interface ShippingCalculationError {
  error: string
}
