import axios from 'axios'

interface ViaCEPResponse {
  cep: string
  logradouro: string
  complemento: string
  bairro: string
  localidade: string
  uf: string
  ibge: string
  gia: string
  ddd: string
  siafi: string
  erro?: boolean
}

export async function fetchCEP(cep: string): Promise<ViaCEPResponse | null> {
  try {
    const clean = cep.replace(/\D/g, '')
    if (clean.length !== 8) throw new Error('CEP inválido')

    const response = await axios.get<ViaCEPResponse>(
      `https://viacep.com.br/ws/${clean}/json/`,
      { timeout: 5000 }
    )

    if (response.data.erro) return null
    return response.data
  } catch (error) {
    console.error('[CEP Service] Erro ao buscar CEP:', error)
    return null
  }
}
