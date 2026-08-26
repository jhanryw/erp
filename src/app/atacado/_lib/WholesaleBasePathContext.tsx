'use client'

/**
 * Repassa o basePath (`''` no host de atacado, `/atacado` em qualquer
 * outro) calculado uma vez no layout (server) pros componentes client do
 * site de atacado — evita cada um precisar ler o host sozinho (client
 * component não tem acesso a `next/headers`).
 */

import { createContext, useContext } from 'react'
import { WHOLESALE_INTERNAL_PREFIX } from '@/lib/wholesale/site-host'

// Default = comportamento de sempre (/atacado) — só usado se algum
// componente client for renderizado fora do Provider por engano.
const WholesaleBasePathContext = createContext<string>(WHOLESALE_INTERNAL_PREFIX)

export function WholesaleBasePathProvider({
  basePath,
  children,
}: {
  basePath: string
  children: React.ReactNode
}) {
  return (
    <WholesaleBasePathContext.Provider value={basePath}>
      {children}
    </WholesaleBasePathContext.Provider>
  )
}

export function useWholesaleBasePath(): string {
  return useContext(WholesaleBasePathContext)
}
