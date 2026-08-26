/**
 * Validação e formatação de CNPJ — mesmo padrão de src/lib/utils/cpf.ts.
 * Novo nesta fase (Fase Fiscal 6): primeira vez que o ERP captura CNPJ de
 * destinatário como dado validado (antes só transitava sem checagem de
 * dígito verificador, ex. deliveryRecipientSchema).
 */

export function validateCNPJ(cnpj: string): boolean {
  const digits = cnpj.replace(/\D/g, '')
  if (digits.length !== 14) return false
  if (/^(\d)\1{13}$/.test(digits)) return false

  const calcDigit = (base: string, weights: number[]): number => {
    const sum = base.split('').reduce((acc, digit, i) => acc + parseInt(digit) * weights[i], 0)
    const rest = sum % 11
    return rest < 2 ? 0 : 11 - rest
  }

  const weights1 = [5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2]
  const digit1 = calcDigit(digits.slice(0, 12), weights1)
  if (digit1 !== parseInt(digits[12])) return false

  const weights2 = [6, 5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2]
  const digit2 = calcDigit(digits.slice(0, 13), weights2)
  return digit2 === parseInt(digits[13])
}

export function formatCNPJ(cnpj: string): string {
  const digits = cnpj.replace(/\D/g, '')
  return digits.replace(/(\d{2})(\d{3})(\d{3})(\d{4})(\d{2})/, '$1.$2.$3/$4-$5')
}

export function cleanCNPJ(cnpj: string): string {
  return cnpj.replace(/\D/g, '')
}
