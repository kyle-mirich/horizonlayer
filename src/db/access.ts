import type { AuthMethod, AuthenticatedPrincipal, OrganizationRole } from '../auth/types.js';

export type AccessContext =
  | { kind: 'system' }
  | ({
      kind: 'user';
    } & AuthenticatedPrincipal);

export const SYSTEM_ACCESS: AccessContext = { kind: 'system' };

export function isSystemAccess(access: AccessContext): boolean {
  return access.kind === 'system';
}

export function requireUserAccess(access: AccessContext): Extract<AccessContext, { kind: 'user' }> {
  if (access.kind !== 'user') {
    throw new Error('Authenticated principal is required');
  }
  return access;
}

export function isOrganizationAdminRole(role: OrganizationRole | null | undefined): boolean {
  return role === 'owner' || role === 'admin';
}

export function isOrganizationAdmin(access: AccessContext): boolean {
  return access.kind === 'user' && Boolean(access.organizationRole) && isOrganizationAdminRole(access.organizationRole);
}

export function canCreateWorkspaces(access: AccessContext): boolean {
  return access.kind === 'system' || access.kind === 'user';
}

export function canMutateOrganizationSettings(access: AccessContext): boolean {
  return access.kind === 'system';
}

export function workspaceReadPredicate(workspaceAlias: string, userParamRef: string): string {
  return `(
    ${workspaceAlias}.owner_user_id = ${userParamRef}
    OR EXISTS (
      SELECT 1
      FROM workspace_members wm
      WHERE wm.workspace_id = ${workspaceAlias}.id
        AND wm.user_id = ${userParamRef}
    )
    OR (
      ${workspaceAlias}.sharing_scope = 'organization'
      AND ${workspaceAlias}.organization_id IS NOT NULL
      AND EXISTS (
        SELECT 1
        FROM organization_members om
        WHERE om.organization_id = ${workspaceAlias}.organization_id
          AND om.user_id = ${userParamRef}
          AND COALESCE(om.status, 'active') = 'active'
      )
    )
  )`;
}

export function workspaceWritePredicate(workspaceAlias: string, userParamRef: string): string {
  return `(
    ${workspaceAlias}.owner_user_id = ${userParamRef}
    OR EXISTS (
      SELECT 1
      FROM workspace_members wm
      WHERE wm.workspace_id = ${workspaceAlias}.id
        AND wm.user_id = ${userParamRef}
        AND wm.role IN ('owner', 'editor')
    )
    OR (
      ${workspaceAlias}.organization_id IS NOT NULL
      AND EXISTS (
        SELECT 1
        FROM organization_members om
        WHERE om.organization_id = ${workspaceAlias}.organization_id
          AND om.user_id = ${userParamRef}
          AND COALESCE(om.status, 'active') = 'active'
          AND om.role IN ('owner', 'admin')
      )
    )
  )`;
}

export function workspaceAccessPredicate(
  workspaceColumn: string,
  userParamRef: string,
  mode: 'read' | 'write'
): string {
  const predicate = mode === 'read'
    ? workspaceReadPredicate('aw', userParamRef)
    : workspaceWritePredicate('aw', userParamRef);
  return `EXISTS (
    SELECT 1
    FROM workspaces aw
    WHERE aw.id = ${workspaceColumn}
      AND ${predicate}
  )`;
}
