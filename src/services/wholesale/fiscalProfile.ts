/** Leitura (somente servidor) do cadastro fiscal usado como fonte opcional do bloco "Nossa loja". */

import { createAdminClient } from '@/lib/supabase/admin'
import { cachedForCompany } from '@/lib/wholesale/ttlCache'
import { cleanLine } from './siteChrome'
import { EMPTY_FISCAL, type FiscalProfile } from './storeInfo'

/** Cadastro fiscal da empresa (só leitura, cache curto). Falha/ausência → vazio (nunca derruba a página). */
export function getFiscalProfile(companyId: number): Promise<FiscalProfile> {
  return cachedForCompany(companyId, 'fiscal-profile', async () => {
    try {
      const { data, error } = await (createAdminClient() as any).from('company_fiscal_settings')
        .select('cnpj, razao_social, nome_fantasia, logradouro, numero_endereco, complemento, bairro, municipio, uf')
        .eq('company_id', companyId).maybeSingle() as { data: Record<string, string | null> | null; error: unknown }
      if (error || !data) return EMPTY_FISCAL
      const s = (v: string | null | undefined) => cleanLine(v ?? '')
      return {
        cnpj: s(data.cnpj), razaoSocial: s(data.razao_social), nomeFantasia: s(data.nome_fantasia),
        logradouro: s(data.logradouro), numero: s(data.numero_endereco), complemento: s(data.complemento),
        bairro: s(data.bairro), municipio: s(data.municipio), uf: s(data.uf).toUpperCase(),
      }
    } catch { return EMPTY_FISCAL }
  })
}
