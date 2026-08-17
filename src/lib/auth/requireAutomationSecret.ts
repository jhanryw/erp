/**
 * Autenticação de endpoints de automação (n8n → Qarvon) — Fase N0.
 *
 * Fundação nova, nenhum endpoint existente foi migrado pra usar isto ainda
 * (seção 4 do pedido: não quebrar workflows atuais — ver relatório da Fase
 * N0, seção H, pro plano de migração gradual). As 5 rotas de automação já
 * existentes (`/api/automations/post-sale/*`, `/api/automations/crm/*`)
 * continuam com sua própria função `isAuthorized()` inline, cada uma
 * checando `N8N_AUTOMATION_SECRET`/`N8N_CRM_SECRET` com `===` simples —
 * não tocado nesta fase.
 *
 * Diferenças desta versão em relação ao padrão atual (melhorias, não
 * mudança de contrato):
 *   1. Comparação em tempo constante (`timingSafeEqual`), não `===` — mesmo
 *      padrão já usado em `verifyChatwootWebhookSignature`/
 *      `verifyNuvemshopHmac`. O padrão atual das 5 rotas de automação usa
 *      `===`, tecnicamente vulnerável a timing attack (risco baixo pra um
 *      bearer token de rota interna, mas sem motivo pra não corrigir em
 *      endpoints novos).
 *   2. Parametrizável por nome de env var — default `QARVON_AUTOMATION_SECRET`
 *      (seção 2 do pedido, nunca reaproveita `CRON_SECRET`/
 *      `SUPABASE_SERVICE_ROLE_KEY`/token do Chatwoot), mas aceita outro
 *      nome pra permitir reaproveitar esta MESMA função numa migração
 *      futura das rotas existentes, sem duplicar a lógica de comparação de
 *      novo — só nesse momento, não agora.
 */

import { timingSafeEqual } from 'crypto'

export type AutomationSecretFailureReason = 'missing_secret_env' | 'missing_header' | 'mismatch'

export type AutomationSecretCheckResult =
  | { ok: true }
  | { ok: false; reason: AutomationSecretFailureReason }

export const QARVON_AUTOMATION_SECRET_ENV_VAR = 'QARVON_AUTOMATION_SECRET'

/**
 * Verifica `Authorization: Bearer <secret>` contra `process.env[envVarName]`
 * (default `QARVON_AUTOMATION_SECRET`). Nunca lança — sempre retorna um
 * resultado tipado, pra quem chama decidir o que logar/responder.
 */
export function checkAutomationSecret(
  request: Request,
  envVarName: string = QARVON_AUTOMATION_SECRET_ENV_VAR,
): AutomationSecretCheckResult {
  const secret = process.env[envVarName]
  if (!secret) return { ok: false, reason: 'missing_secret_env' }

  const authHeader = request.headers.get('Authorization')
  if (!authHeader) return { ok: false, reason: 'missing_header' }

  const expected = Buffer.from(`Bearer ${secret}`, 'utf8')
  const received = Buffer.from(authHeader, 'utf8')

  // Tamanho comparado antes (não vaza informação útil — o tamanho de um
  // header válido é fixo; só o CONTEÚDO precisa de comparação constant-time).
  if (expected.length !== received.length) return { ok: false, reason: 'mismatch' }
  if (!timingSafeEqual(expected, received)) return { ok: false, reason: 'mismatch' }

  return { ok: true }
}

/**
 * Wrapper booleano — mesma ergonomia do `isAuthorized()` já usado inline
 * nas 5 rotas de automação existentes, pra endpoints novos adotarem sem
 * precisar mudar o formato do `if`.
 */
export function requireAutomationSecret(request: Request, envVarName?: string): boolean {
  return checkAutomationSecret(request, envVarName).ok
}

// ─── Resolução de tenant (Fase N1, seção 3 do pedido) ──────────────────────
//
// Um Bearer secret único não carrega `company_id` — nunca pode vir do
// request (query/body/header arbitrário), senão o n8n da Santtorini
// poderia, em tese, consultar dados de qualquer outra empresa só trocando
// um parâmetro. Solução escolhida (a mais simples que resolve o problema
// real, sem inventar uma arquitetura de API keys multi-tenant sem
// necessidade — hoje só existe 1 consumidor real, a Santtorini, mesmo
// raciocínio já usado em `ALERT_COMPANY_ID`/`.env.example`): uma env var
// nova, `QARVON_AUTOMATION_COMPANY_ID`, resolvida só server-side,
// associada a ESTE deployment/secret — nunca hardcoded no código
// (`companyId = 1` não aparece em lugar nenhum) e nunca aceita do request.
//
// Quando existir um segundo tenant consumindo automações, a evolução
// natural é generalizar isto pra uma tabela de credenciais de automação
// por empresa (1 secret → 1 company_id, resolvido por lookup em vez de env
// var) — não implementado agora porque não há hoje um segundo consumidor
// real que justifique a complexidade (mesmo princípio já seguido em
// `company_integrations`/`integration_outbox`: não inventar estrutura sem
// consumidor).

export type AutomationTenantFailureReason = 'missing_config' | 'invalid_config'

export type AutomationTenantResult =
  | { ok: true; companyId: number }
  | { ok: false; reason: AutomationTenantFailureReason }

export function resolveAutomationCompanyId(): AutomationTenantResult {
  const raw = process.env.QARVON_AUTOMATION_COMPANY_ID
  if (!raw) return { ok: false, reason: 'missing_config' }

  const parsed = Number(raw)
  if (!Number.isFinite(parsed) || !Number.isInteger(parsed) || parsed <= 0) {
    return { ok: false, reason: 'invalid_config' }
  }

  return { ok: true, companyId: parsed }
}
