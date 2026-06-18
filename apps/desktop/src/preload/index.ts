import { contextBridge, ipcRenderer } from 'electron';
import type { ApiEnvelope } from '../shared/apiClient.js';
import type { DesktopSettings, ServerStatus } from '../shared/types.js';

contextBridge.exposeInMainWorld('horizon', {
  getSettings: (): Promise<DesktopSettings> => ipcRenderer.invoke('settings:read'),
  request: (request: { body?: unknown; method: 'GET' | 'POST'; path: string }): Promise<ApiEnvelope> => ipcRenderer.invoke('horizon:request', request),
  saveSettings: (settings: DesktopSettings): Promise<DesktopSettings> => ipcRenderer.invoke('settings:write', settings),
  serverStatus: (): Promise<ServerStatus> => ipcRenderer.invoke('server:status'),
  startServer: (): Promise<ServerStatus> => ipcRenderer.invoke('server:start'),
  stopServer: (): Promise<ServerStatus> => ipcRenderer.invoke('server:stop'),
});
