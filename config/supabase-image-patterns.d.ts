export interface ImageRemotePattern {
  protocol?: 'http' | 'https'
  hostname: string
  port?: string
  pathname?: string
}
export const PUBLIC_BUCKET: string
export const STORAGE_PUBLIC_PATH: string
export function buildSupabaseImagePatterns(
  supabaseUrl: string | undefined,
  options?: { production?: boolean },
): ImageRemotePattern[]
