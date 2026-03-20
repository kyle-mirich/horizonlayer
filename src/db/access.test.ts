import { describe, expect, it } from 'vitest';
import {
  canCreateWorkspaces,
  canMutateOrganizationSettings,
  isOrganizationAdmin,
  isOrganizationAdminRole,
  isSystemAccess,
  requireUserAccess,
  SYSTEM_ACCESS,
  workspaceAccessPredicate,
  workspaceReadPredicate,
  workspaceWritePredicate,
  type AccessContext,
} from './access.js';

const userAccess: AccessContext = {
  email: 'user@example.com',
  kind: 'user',
  organizationId: null,
  organizationRole: null,
  scopes: ['openid'],
  userId: 'user-1',
};

describe('db access helpers', () => {
  it('detects system access', () => {
    expect(isSystemAccess(SYSTEM_ACCESS)).toBe(true);
    expect(isSystemAccess(userAccess)).toBe(false);
  });

  it('requires user access for user-only paths', () => {
    expect(requireUserAccess(userAccess)).toEqual(userAccess);
    expect(() => requireUserAccess(SYSTEM_ACCESS)).toThrow('Authenticated principal is required');
  });

  it('recognizes admin roles safely', () => {
    expect(isOrganizationAdminRole('owner')).toBe(true);
    expect(isOrganizationAdminRole('admin')).toBe(true);
    expect(isOrganizationAdminRole('member')).toBe(false);
    expect(isOrganizationAdminRole(null)).toBe(false);
    expect(isOrganizationAdmin(userAccess)).toBe(false);
    expect(
      isOrganizationAdmin({
        ...userAccess,
        organizationRole: 'admin',
      })
    ).toBe(true);
  });

  it('allows workspace creation for system and user access only', () => {
    expect(canCreateWorkspaces(SYSTEM_ACCESS)).toBe(true);
    expect(canCreateWorkspaces(userAccess)).toBe(true);
  });

  it('reserves organization settings mutation for system access', () => {
    expect(canMutateOrganizationSettings(SYSTEM_ACCESS)).toBe(true);
    expect(canMutateOrganizationSettings(userAccess)).toBe(false);
  });

  it('builds owner-only workspace predicates', () => {
    expect(workspaceReadPredicate('w', '$2')).toContain('w.owner_user_id = $2');
    expect(workspaceReadPredicate('w', '$2')).toContain('FROM workspace_members wm');
    expect(workspaceReadPredicate('w', '$2')).toContain('FROM organization_members om');
    expect(workspaceWritePredicate('w', '$2')).toContain('w.owner_user_id = $2');
    expect(workspaceWritePredicate('w', '$2')).toContain("wm.role IN ('owner', 'editor')");
    expect(workspaceWritePredicate('w', '$2')).toContain("om.role IN ('owner', 'admin')");
    expect(workspaceAccessPredicate('p.workspace_id', '$3', 'read')).toContain('aw.owner_user_id = $3');
    expect(workspaceAccessPredicate('p.workspace_id', '$3', 'write')).toContain('wm.role IN (\'owner\', \'editor\')');
  });
});
