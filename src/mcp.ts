import { FastMCP, type Context } from 'fastmcp';

export type AppSessionData = undefined;
export type AppContext = Context<AppSessionData>;
export type AppServer = FastMCP<AppSessionData>;
