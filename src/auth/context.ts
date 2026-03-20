import { SYSTEM_ACCESS, type AccessContext } from '../db/access.js';
import type { AppSession } from '../mcp.js';
import type { AuthMethod } from './types.js';

export function getAccessContext(session?: AppSession): AccessContext {
  if (!session?.userId || !session.authMethod) {
    return SYSTEM_ACCESS;
  }

  return {
    kind: 'user',
    authMethod: session.authMethod as AuthMethod,
    email: session.email ?? null,
    organizationId: null,
    organizationRole: null,
    scopes: Array.isArray(session.scopes) ? session.scopes.filter((value): value is string => typeof value === 'string') : [],
    userId: session.userId,
  };
}
