import { app } from 'electron';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { DesktopSettings } from '../shared/types.js';
import { defaultServerCommand } from './serverManager.js';

const SettingsFile = 'settings.json';

export function defaultSettings(): DesktopSettings {
  return {
    apiBaseUrl: 'http://127.0.0.1:3737',
    externalServerUrl: 'http://127.0.0.1:3737',
    localApiPort: 3737,
    localMcpPort: 3738,
    mode: 'managed',
    serverCommand: defaultServerCommand(),
  };
}

export class SettingsStore {
  private readonly filePath: string;

  constructor(basePath = app.getPath('userData')) {
    this.filePath = path.join(basePath, SettingsFile);
  }

  read(): DesktopSettings {
    try {
      const raw = readFileSync(this.filePath, 'utf8');
      return {
        ...defaultSettings(),
        ...JSON.parse(raw) as Partial<DesktopSettings>,
      };
    } catch {
      return defaultSettings();
    }
  }

  write(settings: DesktopSettings): DesktopSettings {
    mkdirSync(path.dirname(this.filePath), { recursive: true });
    const normalized = {
      ...settings,
      apiBaseUrl: settings.mode === 'external'
        ? settings.externalServerUrl.replace(/\/$/, '')
        : `http://127.0.0.1:${settings.localApiPort}`,
    };
    writeFileSync(this.filePath, JSON.stringify(normalized, null, 2));
    return normalized;
  }
}
