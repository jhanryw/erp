/**
 * Utilitário de formatação de tamanho de arquivo — usado no preview de
 * anexo do composer e na renderização de documento na Thread do CRM
 * (Entrega 8), ambos exibindo o mesmo `file_size` em bytes já retornado
 * pelo Media Hub.
 */
export function formatFileSize(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return '—'
  if (bytes < 1024) return `${bytes} B`
  const units = ['KB', 'MB', 'GB']
  let value = bytes / 1024
  let unitIndex = 0
  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024
    unitIndex += 1
  }
  return `${value.toFixed(value < 10 ? 1 : 0)} ${units[unitIndex]}`
}
