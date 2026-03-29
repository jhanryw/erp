/**
 * Tipagem do banco de dados Santtorini ERP
 * Gerado manualmente a partir do DATABASE_SCHEMA.sql
 * Para regenerar automaticamente: npm run supabase:types
 */

export type Json = string | number | boolean | null | { [key: string]: Json | undefined } | Json[]

// Enums do banco
/** @deprecated Use AppRole de @/types/roles no código novo. 'seller' é legado. */
export type UserRole = 'admin' | 'gerente' | 'seller'
export type ProductOrigin = 'own_brand' | 'third_party'
export type StockEntryType = 'purchase' | 'own_production'
export type PaymentMethod = 'pix' | 'card' | 'cash'
export type SaleStatus = 'pending' | 'paid' | 'shipped' | 'delivered' | 'cancelled' | 'returned'
export type CustomerOrigin = 'instagram' | 'referral' | 'paid_traffic' | 'website' | 'store' | 'other'
export type MarketingCategory = 'paid_traffic' | 'influencers' | 'events' | 'photos' | 'gifts' | 'packaging' | 'rent' | 'salaries' | 'operational' | 'taxes' | 'other'
export type CashbackTransactionType = 'earn' | 'release' | 'use' | 'expire' | 'reverse'
export type CashbackStatus = 'pending' | 'available' | 'used' | 'expired' | 'reversed'
export type FinanceEntryType = 'income' | 'expense'
export type FinanceCategory = 'sale' | 'cashback_used' | 'other_income' | 'stock_purchase' | 'freight_cost' | 'marketing' | 'rent' | 'salaries' | 'operational' | 'taxes' | 'other_expense'
export type ReturnType = 'return' | 'exchange'
export type ReturnStatus = 'pending' | 'processed' | 'rejected'
export type AbcCurve = 'A' | 'B' | 'C'
export type RfmSegment = 'champions' | 'loyal' | 'potential_loyal' | 'new_customers' | 'promising' | 'at_risk' | 'cant_lose' | 'hibernating' | 'lost'

export interface Database {
  public: {
    Tables: {
      users: {
        Row: {
          id: string
          name: string
          role: UserRole
          active: boolean
          created_at: string
          updated_at: string
        }
        Insert: {
          id: string
          name: string
          role?: UserRole
          active?: boolean
          created_at?: string
          updated_at?: string
        }
        Update: {
          name?: string
          role?: UserRole
          active?: boolean
          updated_at?: string
        }
      }
      categories: {
        Row: {
          id: number
          name: string
          slug: string
          parent_id: number | null
          active: boolean
          created_at: string
        }
        Insert: {
          name: string
          slug: string
          parent_id?: number | null
          active?: boolean
        }
        Update: {
          name?: string
          slug?: string
          parent_id?: number | null
          active?: boolean
        }
      }
      collections: {
        Row: {
          id: number
          name: string
          season: string | null
          year: number | null
          active: boolean
          created_at: string
        }
        Insert: {
          name: string
          season?: string | null
          year?: number | null
          active?: boolean
        }
        Update: {
          name?: string
          season?: string | null
          year?: number | null
          active?: boolean
        }
      }
      suppliers: {
        Row: {
          id: number
          name: string
          document: string | null
          phone: string | null
          city: string | null
          state: string | null
          notes: string | null
          active: boolean
          created_at: string
          updated_at: string
        }
        Insert: {
          name: string
          document?: string | null
          phone?: string | null
          city?: string | null
          state?: string | null
          notes?: string | null
          active?: boolean
        }
        Update: {
          name?: string
          document?: string | null
          phone?: string | null
          city?: string | null
          state?: string | null
          notes?: string | null
          active?: boolean
        }
      }
      products: {
        Row: {
          id: number
          name: string
          sku: string
          category_id: number
          subcategory_id: number | null
          collection_id: number | null
          supplier_id: number | null
          origin: ProductOrigin
          base_cost: number
          base_price: number
          margin_pct: number
          markup_pct: number | null
          photo_url: string | null
          active: boolean
          created_at: string
          updated_at: string
        }
        Insert: {
          name: string
          sku: string
          category_id: number
          subcategory_id?: number | null
          collection_id?: number | null
          supplier_id?: number | null
          origin?: ProductOrigin
          base_cost?: number
          base_price: number
          photo_url?: string | null
          active?: boolean
        }
        Update: {
          name?: string
          sku?: string
          category_id?: number
          subcategory_id?: number | null
          collection_id?: number | null
          supplier_id?: number | null
          origin?: ProductOrigin
          base_cost?: number
          base_price?: number
          photo_url?: string | null
          active?: boolean
        }
      }
      product_variations: {
        Row: {
          id: number
          product_id: number
          sku_variation: string
          color: string | null
          size: string | null
          model: string | null
          fabric: string | null
          cost_override: number | null
          price_override: number | null
          photo_url: string | null
          active: boolean
          created_at: string
        }
        Insert: {
          product_id: number
          sku_variation: string
          color?: string | null
          size?: string | null
          model?: string | null
          fabric?: string | null
          cost_override?: number | null
          price_override?: number | null
          photo_url?: string | null
          active?: boolean
        }
        Update: {
          sku_variation?: string
          color?: string | null
          size?: string | null
          model?: string | null
          fabric?: string | null
          cost_override?: number | null
          price_override?: number | null
          photo_url?: string | null
          active?: boolean
        }
      }
      stock: {
        Row: {
          product_variation_id: number
          quantity: number
          avg_cost: number
          last_updated: string
        }
        Insert: {
          product_variation_id: number
          quantity?: number
          avg_cost?: number
        }
        Update: {
          quantity?: number
          avg_cost?: number
          last_updated?: string
        }
      }
      stock_lots: {
        Row: {
          id: number
          product_variation_id: number
          supplier_id: number | null
          entry_type: StockEntryType
          quantity_original: number
          quantity_remaining: number
          unit_cost: number
          freight_cost: number
          tax_cost: number
          total_lot_cost: number
          cost_per_unit: number
          entry_date: string
          notes: string | null
          created_by: string
          created_at: string
        }
        Insert: {
          product_variation_id: number
          supplier_id?: number | null
          entry_type: StockEntryType
          quantity_original: number
          quantity_remaining?: number
          unit_cost?: number
          freight_cost?: number
          tax_cost?: number
          entry_date?: string
          notes?: string | null
          created_by: string
        }
        Update: {
          quantity_remaining?: number
          notes?: string | null
        }
      }
      customers: {
        Row: {
          id: number
          cpf: string
          name: string
          phone: string
          birth_date: string | null
          city: string | null
          state: string | null
          origin: CustomerOrigin | null
          notes: string | null
          active: boolean
          created_at: string
          updated_at: string
          created_by: string
        }
        Insert: {
          cpf: string
          name: string
          phone: string
          birth_date?: string | null
          city?: string | null
          state?: string | null
          origin?: CustomerOrigin | null
          notes?: string | null
          active?: boolean
          created_by: string
        }
        Update: {
          cpf?: string
          name?: string
          phone?: string
          birth_date?: string | null
          city?: string | null
          state?: string | null
          origin?: CustomerOrigin | null
          notes?: string | null
          active?: boolean
        }
      }
      customer_metrics: {
        Row: {
          customer_id: number
          total_spent: number
          order_count: number
          avg_ticket: number
          last_purchase_date: string | null
          rfm_r_score: number | null
          rfm_f_score: number | null
          rfm_m_score: number | null
          rfm_segment: RfmSegment | null
          updated_at: string
        }
        Insert: never
        Update: never
      }
      sales: {
        Row: {
          id: number
          sale_number: string
          customer_id: number
          seller_id: string
          status: SaleStatus
          subtotal: number
          discount_amount: number
          discount_pct: number | null
          cashback_used: number
          shipping_charged: number
          total: number
          payment_method: PaymentMethod
          sale_origin: CustomerOrigin | null
          notes: string | null
          sale_date: string
          created_at: string
          updated_at: string
        }
        Insert: {
          customer_id: number
          seller_id: string
          status?: SaleStatus
          subtotal?: number
          discount_amount?: number
          discount_pct?: number | null
          cashback_used?: number
          shipping_charged?: number
          total?: number
          payment_method: PaymentMethod
          sale_origin?: CustomerOrigin | null
          notes?: string | null
          sale_date?: string
        }
        Update: {
          status?: SaleStatus
          subtotal?: number
          discount_amount?: number
          cashback_used?: number
          shipping_charged?: number
          total?: number
          notes?: string | null
        }
      }
      sale_items: {
        Row: {
          id: number
          sale_id: number
          product_variation_id: number
          stock_lot_id: number | null
          quantity: number
          unit_price: number
          unit_cost: number
          discount_amount: number
          total_price: number
          gross_profit: number
        }
        Insert: {
          sale_id: number
          product_variation_id: number
          stock_lot_id?: number | null
          quantity: number
          unit_price: number
          unit_cost: number
          discount_amount?: number
          total_price: number
        }
        Update: never
      }
      cashback_transactions: {
        Row: {
          id: number
          customer_id: number
          sale_id: number | null
          type: CashbackTransactionType
          amount: number
          status: CashbackStatus
          release_date: string | null
          expiry_date: string | null
          used_at: string | null
          used_in_sale_id: number | null
          reverse_reason: string | null
          created_at: string
        }
        Insert: {
          customer_id: number
          sale_id?: number | null
          type: CashbackTransactionType
          amount: number
          status?: CashbackStatus
          release_date?: string | null
          expiry_date?: string | null
        }
        Update: {
          status?: CashbackStatus
          used_at?: string | null
          used_in_sale_id?: number | null
        }
      }
      finance_entries: {
        Row: {
          id: number
          type: FinanceEntryType
          category: FinanceCategory
          description: string
          amount: number
          reference_date: string
          sale_id: number | null
          stock_lot_id: number | null
          marketing_cost_id: number | null
          return_id: number | null
          notes: string | null
          created_at: string
          created_by: string
        }
        Insert: {
          type: FinanceEntryType
          category: FinanceCategory
          description: string
          amount: number
          reference_date: string
          sale_id?: number | null
          stock_lot_id?: number | null
          marketing_cost_id?: number | null
          return_id?: number | null
          notes?: string | null
          created_by: string
        }
        Update: never
      }
      marketing_costs: {
        Row: {
          id: number
          category: MarketingCategory
          description: string
          amount: number
          cost_date: string
          campaign_id: number | null
          is_recurring: boolean
          notes: string | null
          created_at: string
          created_by: string
        }
        Insert: {
          category: MarketingCategory
          description: string
          amount: number
          cost_date?: string
          campaign_id?: number | null
          is_recurring?: boolean
          notes?: string | null
          created_by: string
        }
        Update: {
          category?: MarketingCategory
          description?: string
          amount?: number
          cost_date?: string
          campaign_id?: number | null
          is_recurring?: boolean
          notes?: string | null
        }
      }
      parameters: {
        Row: {
          key: string
          value: string
          description: string | null
          updated_at: string
          updated_by: string | null
        }
        Insert: {
          key: string
          value: string
          description?: string | null
          updated_by?: string | null
        }
        Update: {
          value?: string
          description?: string | null
          updated_by?: string | null
        }
      }
    }
    Views: {
      v_cashback_balance: {
        Row: {
          customer_id: number
          pending_balance: number
          available_balance: number
          total_used: number
          total_expired: number
          total_reversed: number
        }
      }
      mv_stock_status: {
        Row: {
          product_variation_id: number
          product_id: number
          product_name: string
          sku: string
          color: string | null
          size: string | null
          current_qty: number
          avg_cost: number
          stock_value_at_cost: number
          stock_value_at_price: number
          last_entry_date: string | null
          supplier_id: number | null
        }
      }
      mv_color_performance: {
        Row: {
          color: string
          category_id: number | null
          units_sold: number
          total_revenue: number
          total_gross_profit: number
          avg_margin_pct: number
          avg_ticket: number
          product_count: number
        }
      }
      mv_abc_by_revenue: {
        Row: {
          product_id: number
          product_name: string
          sku: string
          supplier_id: number | null
          supplier_name: string | null
          value: number
          cumulative_pct: number
          abc_curve: AbcCurve
          margin_pct: number | null
        }
      }
      mv_abc_by_profit: {
        Row: {
          product_id: number
          product_name: string
          sku: string
          supplier_id: number | null
          supplier_name: string | null
          value: number
          cumulative_pct: number
          abc_curve: AbcCurve
          margin_pct: number | null
        }
      }
      mv_abc_by_volume: {
        Row: {
          product_id: number
          product_name: string
          sku: string
          supplier_id: number | null
          supplier_name: string | null
          value: number
          cumulative_pct: number
          abc_curve: AbcCurve
          margin_pct: number | null
        }
      }
      mv_supplier_performance: {
        Row: {
          supplier_id: number
          supplier_name: string
          total_purchased_brl: number
          total_revenue: number
          total_gross_profit: number
          avg_margin_pct: number
          top_product_name: string | null
          avg_ticket_per_purchase: number
          product_count: number
        }
      }
      mv_daily_sales_summary: {
        Row: {
          sale_date: string
          total_orders: number
          unique_customers: number
          gross_revenue: number
          total_discounts: number
          total_cashback_used: number
          total_shipping_charged: number
          gross_profit: number
          avg_ticket: number
          cancelled_orders: number
        }
      }
      mv_product_performance: {
        Row: {
          product_id: number
          product_name: string
          sku: string
          category_id: number
          supplier_id: number | null
          base_cost: number
          base_price: number
          margin_pct: number
          total_units_sold: number
          total_revenue: number
          total_gross_profit: number
          total_cost: number
          avg_selling_price: number
          realized_margin_pct: number
          first_sale_date: string | null
          last_sale_date: string | null
        }
      }
      mv_customer_rfm: {
        Row: {
          customer_id: number
          days_since_last_purchase: number
          purchase_count: number
          total_spent: number
          r_score: number
          f_score: number
          m_score: number
          rfm_total: number
          segment: RfmSegment
        }
      }
      mv_monthly_financial: {
        Row: {
          month: string
          total_income: number
          total_expenses: number
          net_result: number
          revenue_sales: number
          revenue_other: number
          exp_stock: number
          exp_marketing: number
          exp_rent: number
          exp_salaries: number
          exp_freight: number
          exp_taxes: number
          exp_operational: number
          exp_other: number
        }
      }
    }
    Functions: {
      consume_stock_fifo: {
        Args: {
          p_product_variation_id: number
          p_quantity: number
        }
        Returns: {
          lot_id: number
          consumed: number
          unit_cost: number
        }[]
      }
    }
    Enums: {
      user_role: UserRole
      product_origin: ProductOrigin
      stock_entry_type: StockEntryType
      payment_method: PaymentMethod
      sale_status: SaleStatus
      customer_origin: CustomerOrigin
      marketing_category: MarketingCategory
      cashback_transaction_type: CashbackTransactionType
      cashback_status: CashbackStatus
      finance_entry_type: FinanceEntryType
      finance_category: FinanceCategory
      return_type: ReturnType
      return_status: ReturnStatus
      abc_curve: AbcCurve
      rfm_segment: RfmSegment
    }
  }
}

// Helpers para extrair tipos das tabelas
export type Tables<T extends keyof Database['public']['Tables']> =
  Database['public']['Tables'][T]['Row']

export type InsertTables<T extends keyof Database['public']['Tables']> =
  Database['public']['Tables'][T]['Insert']

export type UpdateTables<T extends keyof Database['public']['Tables']> =
  Database['public']['Tables'][T]['Update']

export type Views<T extends keyof Database['public']['Views']> =
  Database['public']['Views'][T]['Row']

// Tipos derivados usados na aplicação
export type User = Tables<'users'>
export type Product = Tables<'products'>
export type ProductVariation = Tables<'product_variations'>
export type Supplier = Tables<'suppliers'>

// Dimensões de variação — cada produto pode ter combinações de cor × tamanho × modelo × tecido
export type VariationDimensions = {
  color: string | null
  size: string | null
  model: string | null
  fabric: string | null
}

// Rótulo legível da variação
export function variationLabel(v: VariationDimensions): string {
  return [v.color, v.size, v.model, v.fabric].filter(Boolean).join(' / ') || v.color || 'Padrão'
}

// Views tipadas
export type MvStockStatus = Views<'mv_stock_status'>
export type MvColorPerformance = Views<'mv_color_performance'>
export type MvAbcByRevenue = Views<'mv_abc_by_revenue'>
export type MvAbcByProfit = Views<'mv_abc_by_profit'>
export type MvAbcByVolume = Views<'mv_abc_by_volume'>
export type MvSupplierPerformance = Views<'mv_supplier_performance'>
export type Category = Tables<'categories'>
export type Customer = Tables<'customers'>
export type CustomerMetrics = Tables<'customer_metrics'>
export type Sale = Tables<'sales'>
export type SaleItem = Tables<'sale_items'>
export type StockLot = Tables<'stock_lots'>
export type Stock = Tables<'stock'>
export type CashbackTransaction = Tables<'cashback_transactions'>
export type FinanceEntry = Tables<'finance_entries'>
export type MarketingCost = Tables<'marketing_costs'>

// Tipos compostos para queries com JOIN
export type SaleWithCustomer = Sale & {
  customer: Pick<Customer, 'id' | 'name' | 'cpf' | 'phone'>
  seller: Pick<User, 'id' | 'name'>
  items: (SaleItem & {
    variation: ProductVariation & {
      product: Pick<Product, 'id' | 'name' | 'sku'>
    }
  })[]
}

export type ProductWithDetails = Product & {
  category: Category
  supplier: Pick<Supplier, 'id' | 'name'> | null
  variations: (ProductVariation & {
    stock: Stock | null
  })[]
}

export type CustomerWithMetrics = Customer & {
  metrics: CustomerMetrics | null
  cashback: {
    available_balance: number
    pending_balance: number
  } | null
}
