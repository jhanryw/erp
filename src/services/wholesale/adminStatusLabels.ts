/** Rótulos/estilos dos status do atacado no ERP. Sem regra de negócio — só apresentação (a regra vive em adminStatus.ts/sellability.ts). Seguro pra client component. */
import type { WholesaleAdminStatus, WholesaleVariationStatus } from './adminStatus'

type BadgeVariant = 'success' | 'warning' | 'secondary' | 'error'

export const WHOLESALE_STATUS_LABEL: Record<WholesaleAdminStatus, { label: string; short: string; description: string; variant: BadgeVariant }> = {
  sellable:      { label: 'Vendável', short: 'Ativo', variant: 'success', description: 'Atacado ativo, com preço válido e ao menos uma variação ativa com estoque.' },
  no_price:      { label: 'Atenção: sem preço', short: 'Atenção · sem preço', variant: 'warning', description: 'Atacado ativo, mas nenhuma variação tem preço de atacado válido. Não aparece como vendável.' },
  no_stock:      { label: 'Atenção: sem estoque', short: 'Atenção · sem estoque', variant: 'warning', description: 'Atacado ativo e com preço, mas nenhuma variação tem estoque disponível.' },
  no_variations: { label: 'Atenção: sem variações', short: 'Atenção · sem variações', variant: 'warning', description: 'Atacado ativo, mas o produto não tem nenhuma variação ativa.' },
  disabled:      { label: 'Desativado', short: 'Inativo', variant: 'secondary', description: 'Este produto não participa do atacado.' },
  inactive:      { label: 'Produto inativo', short: 'Produto inativo', variant: 'error', description: 'O produto está inativo no ERP (não vende em nenhum canal).' },
}

export const WHOLESALE_VARIATION_STATUS_LABEL: Record<WholesaleVariationStatus, { label: string; variant: BadgeVariant }> = {
  sellable: { label: 'Vendável', variant: 'success' },
  no_price: { label: 'Sem preço', variant: 'warning' },
  no_stock: { label: 'Sem estoque', variant: 'warning' },
  variation_inactive: { label: 'Variação inativa', variant: 'secondary' },
}
