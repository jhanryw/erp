export const ORIGIN_LABELS: Record<string, string> = {
  instagram:    'Instagram',
  referral:     'Indicação',
  paid_traffic: 'Tráfego Pago',
  website:      'Site',
  store:        'Loja',
  other:        'Outro',
  unknown:      'Sem origem',
}

export const ORIGIN_COLORS: Record<string, string> = {
  instagram:    '#E1306C',
  paid_traffic: '#4267B2',
  referral:     '#22c55e',
  website:      '#f97316',
  store:        '#a855f7',
  other:        '#6b7280',
  unknown:      '#3f3f46',
}

export const ALL_ORIGINS = [
  'instagram',
  'paid_traffic',
  'referral',
  'website',
  'store',
  'other',
  'unknown',
] as const
