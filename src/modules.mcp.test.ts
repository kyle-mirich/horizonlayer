import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { describe, expect, it } from 'vitest';
import type { AppServer } from './mcp.js';
import { createAppServer } from './server.js';

async function listTools(server: AppServer) {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const client = new Client({ name: 'module-contract-test', version: '0.0.1' });
  await client.connect(clientTransport);
  try {
    return (await client.listTools()).tools;
  } finally {
    await client.close();
    await server.stop();
  }
}

describe('module-aware MCP catalog', () => {
  it.each([
    [['knowledge'], ['knowledge']],
    [['issues'], ['issues']],
    [['knowledge', 'issues'], ['knowledge', 'issues']],
  ] as const)('publishes only selected modules: %j', async (modules, expected) => {
    const tools = await listTools(createAppServer({ modules }));
    expect(tools.map((tool) => tool.name)).toEqual(expected);
    expect(tools.every((tool) => tool.inputSchema.type === 'object')).toBe(true);
    expect(JSON.stringify(tools)).not.toContain('workspace_id must');
  });

  it('publishes the eight v2 tools only in explicit legacy mode', async () => {
    const tools = await listTools(createAppServer({ catalogMode: 'legacy' }));
    expect(tools.map((tool) => tool.name)).toEqual([
      'workspace', 'session', 'page', 'database', 'row', 'link', 'search', 'run',
    ]);
  });

  it('keeps the two-tool catalog materially smaller than legacy', async () => {
    const compact = await listTools(createAppServer({ modules: ['knowledge', 'issues'] }));
    const legacy = await listTools(createAppServer({ catalogMode: 'legacy' }));
    expect(JSON.stringify(compact).length).toBeLessThan(JSON.stringify(legacy).length / 5);
  });
});
