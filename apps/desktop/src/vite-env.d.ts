/// <reference types="vite/client" />

import type { HorizonBridge } from './shared/apiClient';
import type { DesktopSettings, ServerStatus } from './shared/types';

declare global {
  interface Window {
    horizon?: HorizonBridge & {
      getSettings: () => Promise<DesktopSettings>;
      saveSettings: (settings: DesktopSettings) => Promise<DesktopSettings>;
      serverStatus: () => Promise<ServerStatus>;
      startServer: () => Promise<ServerStatus>;
      stopServer: () => Promise<ServerStatus>;
    };
  }
}
