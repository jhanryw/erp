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
export type MediaStatus = 'processing' | 'ready' | 'failed'
export type MediaVisibility = 'public' | 'private'
export type MediaUsageEntityType = 'product' | 'product_variation' | 'shipment' | 'crm_message'
export type MediaUsageRole = 'primary' | 'gallery' | 'logo' | 'banner' | 'avatar' | 'proof' | 'attachment' | 'document'
export type CrmChannelType = 'whatsapp' | 'instagram' | 'messenger' | 'email' | 'mercado_livre' | 'shopee' | 'site_chat' | 'telegram' | 'other'
export type CrmPersonCreatedSource = 'manual' | 'import' | 'whatsapp_inbound' | 'instagram_inbound' | 'marketplace_sync' | 'sale_checkout' | 'website_form' | 'other'
export type CrmChannelIdentityCreatedSource = 'manual' | 'inbound_message' | 'import' | 'sale_checkout' | 'marketplace_sync' | 'other'
export type CrmChannelProvider = 'evolution' | 'meta_cloud_api' | 'gmail' | 'microsoft365' | 'smtp' | 'mercado_livre' | 'shopee' | 'custom' | 'other'
export type CrmChannelStatus = 'active' | 'inactive' | 'error'
export type CrmPersonCustomerLinkMatchSource = 'manual' | 'cpf_match' | 'phone_match' | 'email_match' | 'import' | 'sale_checkout' | 'merge'
export type CrmConsentPurpose = 'transactional' | 'marketing' | 'other'
export type CrmConsentEventType = 'granted' | 'revoked'
export type CrmConsentSource = 'whatsapp_message' | 'web_form' | 'manual' | 'sale_checkout' | 'import' | 'verbal_pos' | 'other'
export type CrmConversationStatus = 'open' | 'pending' | 'closed'
export type CrmMessageDirection = 'inbound' | 'outbound'
export type CrmMessageStatus = 'received' | 'pending' | 'sent' | 'delivered' | 'read' | 'failed'
export type CrmMessageContentType = 'text' | 'image' | 'audio' | 'video' | 'document' | 'location' | 'contact' | 'other'
export type CrmMessageCreatedSource = 'manual' | 'automation' | 'inbound_webhook' | 'other'

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
          ncm: string | null
          cest: string | null
          origem: number | null
          unidade_med: string
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
          ncm?: string | null
          cest?: string | null
          origem?: number | null
          unidade_med?: string
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
          ncm?: string | null
          cest?: string | null
          origem?: number | null
          unidade_med?: string
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
      media: {
        Row: {
          id: number
          public_id: string
          company_id: number
          storage_key: string | null
          external_url: string | null
          visibility: MediaVisibility
          original_filename: string | null
          extension: string | null
          mime_type: string
          file_size: number
          width: number | null
          height: number | null
          checksum_sha256: string | null
          status: MediaStatus
          created_source: string
          metadata: Json
          uploaded_by: string | null
          alt_text: string | null
          active: boolean
          created_at: string
          updated_at: string
        }
        Insert: {
          public_id?: string
          company_id: number
          storage_key?: string | null
          external_url?: string | null
          visibility?: MediaVisibility
          original_filename?: string | null
          extension?: string | null
          mime_type: string
          file_size: number
          width?: number | null
          height?: number | null
          checksum_sha256?: string | null
          status?: MediaStatus
          created_source: string
          metadata?: Json
          uploaded_by?: string | null
          alt_text?: string | null
          active?: boolean
        }
        Update: {
          visibility?: MediaVisibility
          original_filename?: string | null
          alt_text?: string | null
          active?: boolean
          updated_at?: string
        }
      }
      media_usages: {
        Row: {
          id: number
          media_id: number
          entity_type: MediaUsageEntityType
          entity_id: string
          role: MediaUsageRole
          position: number
          company_id: number
          created_at: string
          created_by: string | null
        }
        Insert: {
          media_id: number
          entity_type: MediaUsageEntityType
          entity_id: string
          role?: MediaUsageRole
          position?: number
          company_id: number
          created_by?: string | null
        }
        Update: {
          role?: MediaUsageRole
          position?: number
        }
      }
      crm_persons: {
        Row: {
          id: number
          company_id: number
          display_name: string
          notes: string | null
          created_source: CrmPersonCreatedSource
          active: boolean
          created_at: string
          updated_at: string
          created_by: string | null
        }
        Insert: {
          company_id: number
          display_name: string
          notes?: string | null
          created_source: CrmPersonCreatedSource
          active?: boolean
          created_by?: string | null
        }
        Update: {
          display_name?: string
          notes?: string | null
          active?: boolean
          updated_at?: string
        }
      }
      crm_organizations: {
        Row: {
          id: number
          company_id: number
          name: string
          tax_id: string | null
          segment: string | null
          notes: string | null
          created_source: CrmPersonCreatedSource
          active: boolean
          created_at: string
          updated_at: string
          created_by: string | null
        }
        Insert: {
          company_id: number
          name: string
          tax_id?: string | null
          segment?: string | null
          notes?: string | null
          created_source: CrmPersonCreatedSource
          active?: boolean
          created_by?: string | null
        }
        Update: {
          name?: string
          tax_id?: string | null
          segment?: string | null
          notes?: string | null
          active?: boolean
          updated_at?: string
        }
      }
      crm_company_contacts: {
        Row: {
          id: number
          company_id: number
          organization_id: number
          person_id: number
          role: string | null
          is_primary: boolean
          active: boolean
          created_at: string
          created_by: string | null
        }
        Insert: {
          company_id: number
          organization_id: number
          person_id: number
          role?: string | null
          is_primary?: boolean
          active?: boolean
          created_by?: string | null
        }
        Update: {
          role?: string | null
          is_primary?: boolean
          active?: boolean
        }
      }
      crm_channels: {
        Row: {
          id: number
          company_id: number
          name: string
          channel_type: CrmChannelType
          provider: CrmChannelProvider
          provider_instance_identifier: string | null
          external_config: Json
          status: CrmChannelStatus
          active: boolean
          created_at: string
          updated_at: string
          created_by: string | null
        }
        Insert: {
          company_id: number
          name: string
          channel_type: CrmChannelType
          provider: CrmChannelProvider
          provider_instance_identifier?: string | null
          external_config?: Json
          status?: CrmChannelStatus
          active?: boolean
          created_by?: string | null
        }
        Update: {
          name?: string
          provider_instance_identifier?: string | null
          external_config?: Json
          status?: CrmChannelStatus
          active?: boolean
          updated_at?: string
        }
      }
      crm_channel_identities: {
        Row: {
          id: number
          company_id: number
          person_id: number
          channel_type: CrmChannelType
          value: string
          verified: boolean
          created_source: CrmChannelIdentityCreatedSource
          active: boolean
          created_at: string
          updated_at: string
        }
        Insert: {
          company_id: number
          person_id: number
          channel_type: CrmChannelType
          value: string
          verified?: boolean
          created_source: CrmChannelIdentityCreatedSource
          active?: boolean
        }
        Update: {
          verified?: boolean
          active?: boolean
          updated_at?: string
        }
      }
      crm_person_customer_links: {
        Row: {
          id: number
          company_id: number
          person_id: number
          customer_id: number
          match_source: CrmPersonCustomerLinkMatchSource
          is_primary: boolean
          active: boolean
          created_at: string
          created_by: string | null
        }
        Insert: {
          company_id: number
          person_id: number
          customer_id: number
          match_source: CrmPersonCustomerLinkMatchSource
          is_primary?: boolean
          active?: boolean
          created_by?: string | null
        }
        Update: {
          is_primary?: boolean
          active?: boolean
        }
      }
      crm_consent_events: {
        Row: {
          id: number
          company_id: number
          person_id: number
          purpose: CrmConsentPurpose
          channel_type: CrmChannelType | null
          event_type: CrmConsentEventType
          source: CrmConsentSource
          evidence: Json | null
          occurred_at: string
          created_by: string | null
          created_at: string
        }
        Insert: {
          company_id: number
          person_id: number
          purpose: CrmConsentPurpose
          channel_type?: CrmChannelType | null
          event_type: CrmConsentEventType
          source: CrmConsentSource
          evidence?: Json | null
          occurred_at?: string
          created_by?: string | null
        }
        Update: never
      }
      crm_conversations: {
        Row: {
          id: number
          company_id: number
          channel_id: number
          channel_identity_id: number
          person_id: number
          status: CrmConversationStatus
          last_message_at: string | null
          created_at: string
          updated_at: string
        }
        Insert: {
          company_id: number
          channel_id: number
          channel_identity_id: number
          person_id: number
          status?: CrmConversationStatus
        }
        Update: {
          status?: CrmConversationStatus
          updated_at?: string
        }
      }
      crm_messages: {
        Row: {
          id: number
          company_id: number
          conversation_id: number
          channel_id: number
          person_id: number
          direction: CrmMessageDirection
          status: CrmMessageStatus
          status_updated_at: string
          content: string | null
          content_type: CrmMessageContentType
          failure_reason: string | null
          external_message_id: string | null
          n8n_execution_id: string | null
          created_source: CrmMessageCreatedSource
          created_by: string | null
          created_at: string
          metadata: Json | null
          sent_at: string | null
          delivered_at: string | null
          read_at: string | null
          failed_at: string | null
          client_dedupe_key: string | null
          reply_to_message_id: number | null
        }
        Insert: {
          company_id: number
          conversation_id: number
          channel_id: number
          person_id: number
          direction: CrmMessageDirection
          status: CrmMessageStatus
          content?: string | null
          content_type: CrmMessageContentType
          failure_reason?: string | null
          external_message_id?: string | null
          n8n_execution_id?: string | null
          created_source: CrmMessageCreatedSource
          created_by?: string | null
          metadata?: Json | null
          client_dedupe_key?: string | null
          reply_to_message_id?: number | null
        }
        Update: {
          status?: CrmMessageStatus
          status_updated_at?: string
          failure_reason?: string | null
          external_message_id?: string | null
        }
      }
    }
    Views: {
      v_crm_consent_status: {
        Row: {
          person_id: number
          company_id: number
          purpose: CrmConsentPurpose
          channel_type: CrmChannelType | null
          status: CrmConsentEventType
          last_source: CrmConsentSource
          last_occurred_at: string
        }
      }
      v_crm_conversation_last_message: {
        Row: {
          conversation_id: number
          message_id: number
          content: string | null
          content_type: CrmMessageContentType
          direction: CrmMessageDirection
          status: CrmMessageStatus
          created_at: string
        }
      }
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
          current_qty: number
          avg_cost: number
          stock_value_at_cost: number
          stock_value_at_price: number
          base_price: number
          margin_pct: number
          last_entry_date: string | null
          last_sale_date: string | null
        }
      }
      mv_color_performance: {
        Row: {
          color_name: string
          total_items_sold: number
          total_units_sold: number
          total_revenue: number
          total_gross_profit: number
          avg_price: number
          avg_ticket_contribution: number | null
        }
      }
      mv_abc_by_revenue: {
        Row: {
          product_id: number
          total_revenue: number
          revenue_pct: number
          cumulative_pct: number
          abc_class: AbcCurve
        }
      }
      mv_abc_by_profit: {
        Row: {
          product_id: number
          total_gross_profit: number
          profit_pct: number
          cumulative_pct: number
          abc_class: AbcCurve
        }
      }
      mv_abc_by_volume: {
        Row: {
          product_id: number
          total_units_sold: number
          volume_pct: number
          cumulative_pct: number
          abc_class: AbcCurve
        }
      }
      mv_supplier_performance: {
        Row: {
          // ── identidade ──────────────────────────────────────────────────
          supplier_id: number
          supplier_name: string
          supplier_state: string | null
          // ── compras (precisos) ──────────────────────────────────────────
          total_lots: number
          total_units_purchased: number
          total_purchased_value: number
          total_freight_cost: number
          total_tax_cost: number
          avg_real_cost_per_unit: number
          avg_freight_pct: number
          avg_tax_pct: number
          product_count: number
          // ── vendas legadas (lógica anterior, pode sobrecontar) ──────────
          total_units_sold: number
          total_revenue: number
          total_gross_profit: number
          avg_margin_pct: number
          // ── estimativas de venda (atribuição por variação, não por lote) ─
          estimated_total_units_sold: number
          estimated_total_revenue: number
          estimated_gross_profit: number
          estimated_margin_pct: number
        }
      }
      vw_supplier_cost_by_product: {
        Row: {
          supplier_id: number
          supplier_name: string
          supplier_state: string | null
          product_id: number
          product_name: string
          product_variation_id: number
          sku_variation: string
          total_lots: number
          total_qty_purchased: number
          avg_unit_cost: number
          avg_cost_per_unit: number
          avg_freight_per_unit: number
          avg_tax_per_unit: number
          freight_impact_pct: number
          tax_impact_pct: number
          real_cost_impact_pct: number
          last_purchase_date: string
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
      crm_channel_type: CrmChannelType
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
export type VwSupplierCostByProduct = Views<'vw_supplier_cost_by_product'>
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

// CRM — camada de identidade (Fase 3, Entrega 1)
export type CrmPerson = Tables<'crm_persons'>
export type CrmOrganization = Tables<'crm_organizations'>
export type CrmCompanyContact = Tables<'crm_company_contacts'>
export type CrmChannel = Tables<'crm_channels'>
export type CrmChannelIdentity = Tables<'crm_channel_identities'>
export type CrmPersonCustomerLink = Tables<'crm_person_customer_links'>
export type CrmConsentEvent = Tables<'crm_consent_events'>
export type CrmConsentStatus = Views<'v_crm_consent_status'>
export type CrmConversation = Tables<'crm_conversations'>
export type CrmMessage = Tables<'crm_messages'>
export type CrmConversationLastMessage = Views<'v_crm_conversation_last_message'>

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
