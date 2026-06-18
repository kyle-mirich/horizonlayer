import { describe, expect, it } from 'vitest';
import { buildManagedServerEnv } from './serverManager.js';

describe('managed server environment', () => {
  it('enables the dashboard API and HTTP MCP transport on separate ports', () => {
    const env = buildManagedServerEnv({
      apiPort: 3737,
      mcpPort: 3738,
    });

    expect(env).toMatchObject({
      DASHBOARD_API_ENABLED: 'true',
      DASHBOARD_API_HOST: '127.0.0.1',
      DASHBOARD_API_PORT: '3737',
      HOST: '127.0.0.1',
      PORT: '3738',
      SERVER_TRANSPORT: 'httpStream',
    });
  });
});
