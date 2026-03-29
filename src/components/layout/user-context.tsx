'use client'

/**
 * Contexto de perfil do usuário para Client Components do dashboard.
 *
 * O perfil (nome e role) é buscado no layout (Server Component) via DB e
 * injetado aqui via UserRoleProvider. Client Components como Sidebar e
 * MobileNav consomem via useUserContext() sem fazer queries extras.
 *
 * Fluxo:
 *   layout.tsx (Server) → getUserProfile() → <UserRoleProvider> → useUserContext()
 */

import { createContext, useContext } from 'react'
import type { AppRole } from '@/types/roles'

interface UserContextValue {
  userName: string
  userRole: AppRole
}

const UserContext = createContext<UserContextValue>({
  userName: 'Usuário',
  userRole: 'usuario',
})

export function UserRoleProvider({
  children,
  userName,
  userRole,
}: {
  children: React.ReactNode
  userName: string
  userRole: AppRole
}) {
  return (
    <UserContext.Provider value={{ userName, userRole }}>
      {children}
    </UserContext.Provider>
  )
}

/**
 * Hook para ler nome e role do usuário em Client Components.
 * Deve ser usado dentro de um componente filho de UserRoleProvider.
 */
export function useUserContext(): UserContextValue {
  return useContext(UserContext)
}
