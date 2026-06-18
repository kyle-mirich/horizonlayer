import { app, BrowserWindow, ipcMain } from 'electron';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ServerManager } from './serverManager.js';
import { SettingsStore } from './settingsStore.js';
import type { ApiEnvelope } from '../shared/apiClient.js';
import type { DesktopSettings } from '../shared/types.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const settingsStore = new SettingsStore();
const serverManager = new ServerManager();

function createWindow(): void {
  const window = new BrowserWindow({
    backgroundColor: '#f7f7f4',
    height: 860,
    minHeight: 720,
    minWidth: 1120,
    title: 'HorizonLayer',
    titleBarStyle: 'hiddenInset',
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      preload: path.join(__dirname, '../preload/index.js'),
    },
    width: 1280,
  });

  window.loadFile(path.join(__dirname, '../../renderer/index.html'));
}

async function proxyApiRequest(input: {
  body?: unknown;
  method: 'GET' | 'POST';
  path: string;
}): Promise<ApiEnvelope> {
  const settings = settingsStore.read();
  const baseUrl = serverManager.apiBaseUrl(settings);
  const response = await fetch(`${baseUrl}${input.path}`, {
    body: input.body === undefined ? undefined : JSON.stringify(input.body),
    headers: { 'Content-Type': 'application/json' },
    method: input.method,
  });
  return await response.json() as ApiEnvelope;
}

ipcMain.handle('settings:read', () => settingsStore.read());
ipcMain.handle('settings:write', (_event, settings: DesktopSettings) => settingsStore.write(settings));
ipcMain.handle('server:status', () => serverManager.status(settingsStore.read()));
ipcMain.handle('server:start', () => serverManager.start(settingsStore.read()));
ipcMain.handle('server:stop', () => serverManager.stop(settingsStore.read()));
ipcMain.handle('horizon:request', (_event, input: Parameters<typeof proxyApiRequest>[0]) => proxyApiRequest(input));

app.whenReady().then(() => {
  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

app.on('before-quit', () => {
  serverManager.stop(settingsStore.read());
});
