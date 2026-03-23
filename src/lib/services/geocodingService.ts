import axios from 'axios'

interface NominatimResponse {
  lat: string
  lon: string
  address?: any
}

export async function geocodeAddress(address: string): Promise<{ lat: number; lon: number } | null> {
  try {
    const response = await axios.get<NominatimResponse[]>(
      'https://nominatim.openstreetmap.org/search',
      {
        params: {
          q: address,
          format: 'json',
          limit: 1,
          'accept-language': 'pt-BR',
        },
        timeout: 5000,
        headers: { 'User-Agent': 'SanttoriniERP/1.0' },
      }
    )

    if (!response.data || response.data.length === 0) return null
    const result = response.data[0]
    return { lat: parseFloat(result.lat), lon: parseFloat(result.lon) }
  } catch (error) {
    console.error('[Geocoding Service] Erro ao geocodificar:', error)
    return null
  }
}

export function calculateDistance(
  lat1: number,
  lon1: number,
  lat2: number,
  lon2: number
): number {
  const R = 6371 // Earth radius in km
  const dLat = ((lat2 - lat1) * Math.PI) / 180
  const dLon = ((lon2 - lon1) * Math.PI) / 180
  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos((lat1 * Math.PI) / 180) * Math.cos((lat2 * Math.PI) / 180) * Math.sin(dLon / 2) * Math.sin(dLon / 2)
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a))
  return R * c
}
