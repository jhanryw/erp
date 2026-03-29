/**
 * Sistema de roles do ERP Santtorini.
 *
 * Hierarquia de permissões (maior número = mais acesso):
 *   admin   (3) → acesso total, incluindo configurações e gestão de usuários
 *   gerente (2) → acesso financeiro, relatórios, produtos, estoque e fornecedores
 *   usuario (1) → operação básica: vendas, clientes e consulta de estoque
 *
 * ─── Migração SQL obrigatória (executar uma vez no banco de produção) ───────
 *
 *   -- 1. Adicionar 'gerente' ao enum do banco
 *   ALTER TYPE user_role ADD VALUE IF NOT EXISTS 'gerente';
 *
 *   -- 2. Sincronizar role para user_metadata do Supabase Auth
 *   --    (necessário para a verificação no middleware)
 *   UPDATE auth.users au
 *   SET raw_user_meta_data = raw_user_meta_data || jsonb_build_object('role', pu.role)
 *   FROM public.users pu
 *   WHERE au.id = pu.id;
 *
 *   -- 3. Trigger para manter sincronizado em novos usuários (opcional, recomendado)
 *   CREATE OR REPLACE FUNCTION sync_role_to_auth_metadata()
 *   RETURNS TRIGGER AS $$
 *   BEGIN
 *     UPDATE auth.users
 *     SET raw_user_meta_data = raw_user_meta_data || jsonb_build_object('role', NEW.role)
 *     WHERE id = NEW.id;
 *     RETURN NEW;
 *   END;
 *   $$ LANGUAGE plpgsql SECURITY DEFINER;
 *
 *   DROP TRIGGER IF EXISTS trg_sync_role ON public.users;
 *   CREATE TRIGGER trg_sync_role
 *   AFTER INSERT OR UPDATE OF role ON public.users
 *   FOR EACH ROW EXECUTE FUNCTION sync_role_to_auth_metadata();
 *
 * ────────────────────────────────────────────────────────────────────────────
 */

export type AppRole = 'admin' | 'gerente' | 'usuario'

// Hierarquia numérica — quanto maior, mais privilégios
const HIERARCHY: Record<AppRole, number> = {
  admin: 3,
  gerente: 2,
  usuario: 1,
}

/**
 * Retorna true se userRole tem acesso suficiente para o minRole exigido.
 * Implementa a hierarquia: admin > gerente > usuario.
 *
 * @example
 * hasMinRole('admin', 'gerente')  // true  — admin passa em rotas de gerente
 * hasMinRole('gerente', 'gerente') // true  — gerente passa em rotas de gerente
 * hasMinRole('usuario', 'gerente') // false — usuário não passa em rotas de gerente
 */
export function hasMinRole(userRole: AppRole, minRole: AppRole): boolean {
  return HIERARCHY[userRole] >= HIERARCHY[minRole]
}

/** Labels de exibição para cada role */
export const ROLE_LABELS: Record<AppRole, string> = {
  admin: 'Administrador',
  gerente: 'Gerente',
  usuario: 'Usuário',
}

/**
 * Normaliza valores de role vindos do banco ou de user_metadata
 * para o tipo AppRole canônico usado na aplicação.
 *
 * Mapeamento:
 *   'admin'            → 'admin'
 *   'gerente'          → 'gerente'
 *   'seller'           → 'usuario'  (legado — renomeado)
 *   null/undefined/??? → 'usuario'  (fallback seguro — menor privilégio)
 */
export function normalizeRole(raw: string | null | undefined): AppRole {
  if (raw === 'admin') return 'admin'
  if (raw === 'gerente') return 'gerente'
  if (raw === 'seller') return 'usuario' // retrocompatibilidade com valor legado
  return 'usuario' // fallback: menor privilégio possível
}
