/**
 * Contexto das APIs/páginas PÚBLICAS do catálogo de atacado: tenant +
 * configuração, com `wholesale_site_settings.catalog_active` como controle
 * MESTRE — catálogo desativado = nenhuma API de catálogo responde, independente
 * de quantos produtos estejam habilitados (`products.wholesale_enabled`).
 */

import { NextResponse } from 'next/server'
import { logError } from '@/lib/errors/log'
import { resolveWholesaleSiteTenant } from './tenant'
import { getWholesaleSiteSettings, type WholesaleSiteSettings } from '@/services/wholesale/settings'

export type WholesalePublicContext =
  | { ok: true; companyId: number; settings: WholesaleSiteSettings }
  | { ok: false; status: number; error: string }

export async function resolveWholesalePublicContext(): Promise<WholesalePublicContext> {
  try {
    const tenant = await resolveWholesaleSiteTenant()
    if (!tenant) return { ok: false, status: 503, error: 'Site de atacado não configurado.' }

    const settings = await getWholesaleSiteSettings(tenant.companyId)
    if (!settings.catalogActive) return { ok: false, status: 503, error: 'Catálogo temporariamente indisponível.' }

    return { ok: true, companyId: tenant.companyId, settings }
  } catch (err) {
    // Falha ao resolver tenant/configuração → fecha (503), nunca abre o catálogo por padrão.
    logError({ route: 'wholesale.resolvePublicContext', err })
    return { ok: false, status: 503, error: 'Catálogo temporariamente indisponível.' }
  }
}

/**
 * Resposta 500 padronizada das APIs públicas do catálogo: registra o erro
 * (stderr + tabela error_logs, via logError) SEM dados pessoais e devolve
 * mensagem genérica — nunca o texto técnico do banco.
 */
export function publicRouteError(route: string, err: unknown, context: Record<string, unknown> = {}): Response {
  logError({ route, err, context })
  return NextResponse.json({ error: 'internal_error', message: 'Não foi possível concluir a operação. Tente novamente.' }, { status: 500 })
}
