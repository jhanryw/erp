/**
 * Dispatch de provider por crm_channels.provider (Entrega 6).
 *
 * Único ponto que decide "qual adaptador chamar" — outbound-message.service.ts
 * nunca sabe o nome de um provider específico, só chama getProvider(channel.provider).
 * Provider sem implementação retorna null — o chamador trata como falha de
 * envio (mensagem criada, status='failed'), não como erro de sistema.
 */

import type { CrmChannelProvider } from '@/types/database.types'
import type { MessageProvider } from './types'
import { EvolutionProvider } from './evolution.provider'

const evolutionProvider = new EvolutionProvider()

export function getProvider(provider: CrmChannelProvider): MessageProvider | null {
  switch (provider) {
    case 'evolution':
      return evolutionProvider
    default:
      return null
  }
}
