import { FastMCP, type Context } from 'fastmcp';

export interface AppSession extends Record<string, unknown> {
  accessToken?: string;
  authMethod?: string;
  email?: string | null;
  scopes?: string[];
  subject?: string;
  userId?: string;
}

export type AppSessionData = AppSession | undefined;
export type AppContext = Context<AppSessionData>;
export type AppServer = FastMCP<AppSessionData>;
