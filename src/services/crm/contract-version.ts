/**
 * Versionamento do contrato N8N→ERP (CRM) — Entrega 1.
 *
 * `contract_version` ausente = assume 1 (compatibilidade com os workflows
 * atuais do N8N, que ainda não enviam o campo). Presente com valor fora de
 * `SUPPORTED_CONTRACT_VERSIONS` = erro permanente de configuração, 422,
 * antes de qualquer outra validação de payload — mesma disciplina de
 * "canal inexistente" já usada nas rotas de automação do CRM.
 *
 * Contrato aditivo dentro da v1; mudança incompatível vira v2 futura.
 */

export const SUPPORTED_CONTRACT_VERSIONS = [1] as const
export type SupportedContractVersion = (typeof SUPPORTED_CONTRACT_VERSIONS)[number]

export type ContractVersionCheck =
  | { ok: true; version: SupportedContractVersion }
  | { ok: false }

export function checkContractVersion(body: unknown): ContractVersionCheck {
  const raw =
    body && typeof body === 'object' && 'contract_version' in body
      ? (body as { contract_version: unknown }).contract_version
      : undefined

  if (raw === undefined || raw === null) {
    return { ok: true, version: 1 }
  }

  if ((SUPPORTED_CONTRACT_VERSIONS as readonly unknown[]).includes(raw)) {
    return { ok: true, version: raw as SupportedContractVersion }
  }

  return { ok: false }
}

export const unsupportedContractVersionBody = {
  error: 'unsupported_contract_version',
  supported_versions: SUPPORTED_CONTRACT_VERSIONS,
}
