/**
 * Bloco "Nossa loja" do rodapé. Cada campo: valor digitado no ERP > dado do cadastro fiscal (SÓ se
 * `useFiscalData` estiver ligado) > vazio. Nada é inventado; campo vazio não gera linha nem bloco.
 * Módulo PURO (usado também no cliente do ERP); a leitura do banco fica em `fiscalProfile.ts`.
 */

import { formatCnpj, isValidCnpj, type ResolvedSiteChrome } from './siteChrome'

export interface FiscalProfile {
  cnpj: string; razaoSocial: string; nomeFantasia: string
  logradouro: string; numero: string; complemento: string; bairro: string; municipio: string; uf: string
}

export interface StoreInfo {
  legalName: string
  tradeName: string
  cnpj: string
  addressLine: string
  city: string
  state: string
  mapsUrl: string
}

export const EMPTY_FISCAL: FiscalProfile = { cnpj: '', razaoSocial: '', nomeFantasia: '', logradouro: '', numero: '', complemento: '', bairro: '', municipio: '', uf: '' }

export function fiscalAddressLine(f: FiscalProfile): string {
  const street = [f.logradouro, f.numero].filter(Boolean).join(', ')
  return [street, f.complemento, f.bairro].filter(Boolean).join(' — ')
}

export function resolveStoreInfo(store: ResolvedSiteChrome['store'], fiscal: FiscalProfile | null, displayName: string | null): StoreInfo {
  const f = store.useFiscalData && fiscal ? fiscal : EMPTY_FISCAL
  const rawCnpj = store.cnpj || f.cnpj
  return {
    legalName: store.legalName || f.razaoSocial,
    tradeName: store.tradeName || f.nomeFantasia || (displayName ?? ''),
    cnpj: rawCnpj && isValidCnpj(rawCnpj) ? formatCnpj(rawCnpj) : '',
    addressLine: store.addressLine || fiscalAddressLine(f),
    city: store.city || f.municipio,
    state: store.state || (/^[A-Z]{2}$/.test(f.uf) ? f.uf : ''),
    mapsUrl: store.mapsUrl,
  }
}

/** O bloco só existe se houver ALGO real para mostrar (nome fantasia herdado do `displayName` não conta sozinho). */
export function hasStoreContent(info: StoreInfo, hasExplicitName: boolean): boolean {
  return !!(info.legalName || info.cnpj || info.addressLine || info.city || info.mapsUrl || hasExplicitName)
}
