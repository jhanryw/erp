'use client'

import { useEffect, useRef } from 'react'
import { createClient } from '@/lib/supabase/client'

// Espelha só as colunas de crm_messages que a Inbox/Thread realmente
// consomem em tempo real — não é o Row completo gerado do banco (evita
// acoplar este hook ao schema inteiro por um campo que ninguém usa aqui).
export interface CrmRealtimeMessageRow {
  id: number
  company_id: number
  conversation_id: number
  direction: 'inbound' | 'outbound'
  status: string
  content: string | null
  content_type: string
  metadata: Record<string, unknown> | null
  failure_reason: string | null
  created_at: string
  reply_to_message_id: number | null
}

export interface CrmRealtimeMessageEvent {
  eventType: 'INSERT' | 'UPDATE'
  row: CrmRealtimeMessageRow
}

/**
 * 1 canal Realtime por empresa, escutando INSERT/UPDATE em crm_messages
 * filtrado por company_id (migration 20260718_crm_realtime_publication.sql
 * habilita a tabela na publication). RLS (`crm_messages_company`) já é a
 * fronteira de segurança real — o filtro aqui é defesa em
 * profundidade/redução de tráfego, não a única barreira.
 *
 * `onEvent` fica em ref para nunca recriar o canal por causa de uma closure
 * nova a cada render do chamador (Inbox re-renderiza a cada mensagem) — só
 * `companyId` muda reabre a subscription. Cleanup total (unsubscribe) no
 * unmount ou troca de companyId, via `supabase.removeChannel()`.
 */
export function useCrmRealtime(
  companyId: number | null,
  onEvent: (event: CrmRealtimeMessageEvent) => void,
): void {
  const onEventRef = useRef(onEvent)
  onEventRef.current = onEvent

  useEffect(() => {
    if (!companyId) return

    const supabase = createClient()
    const channel = supabase
      .channel(`crm-inbox-company-${companyId}`)
      .on(
        'postgres_changes',
        { event: 'INSERT', schema: 'public', table: 'crm_messages', filter: `company_id=eq.${companyId}` },
        (payload) => {
          onEventRef.current({ eventType: 'INSERT', row: payload.new as unknown as CrmRealtimeMessageRow })
        },
      )
      .on(
        'postgres_changes',
        { event: 'UPDATE', schema: 'public', table: 'crm_messages', filter: `company_id=eq.${companyId}` },
        (payload) => {
          onEventRef.current({ eventType: 'UPDATE', row: payload.new as unknown as CrmRealtimeMessageRow })
        },
      )
      .subscribe()

    return () => {
      supabase.removeChannel(channel)
    }
  }, [companyId])
}
