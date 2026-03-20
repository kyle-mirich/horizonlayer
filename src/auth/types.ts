export const OrganizationRoleValues = ['owner', 'admin', 'member', 'viewer'] as const;
export type OrganizationRole = (typeof OrganizationRoleValues)[number];

export const WorkspaceRoleValues = ['owner', 'editor', 'viewer'] as const;
export type WorkspaceRole = (typeof WorkspaceRoleValues)[number];

export const AuthMethodValues = ['local_admin', 'google_oidc', 'microsoft_oidc', 'generic_oidc'] as const;
export type AuthMethod = (typeof AuthMethodValues)[number];

export interface AuthenticatedPrincipal {
  userId: string;
  authMethod: AuthMethod;
  organizationId?: string | null;
  organizationRole?: OrganizationRole | null;
  sessionId?: string | null;
  email?: string | null;
  scopes?: string[];
}

export interface OrganizationAuthPolicy {
  allow_local_login: boolean;
  enforce_sso: boolean;
  default_member_role: Extract<OrganizationRole, 'member' | 'viewer'>;
}
