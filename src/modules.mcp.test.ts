import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { readFileSync } from 'node:fs';
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
  it('delivers packaged server and module artwork through the MCP handshake', async () => {
    const server = createAppServer({ modules: ['knowledge', 'issues'] });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    const client = new Client({ name: 'icon-contract-test', version: '0.0.1' });
    await client.connect(clientTransport);
    try {
      const info = client.getServerVersion();
      expect(info?.title).toBe('HorizonLayer');
      expect(info?.websiteUrl).toBe('https://github.com/kyle-mirich/horizonlayer');
      const tools = (await client.listTools()).tools;
      expect(tools.map((tool) => tool.title)).toEqual(['HorizonLayer Knowledge', 'HorizonLayer Issues']);
      for (const [name, icons] of [
        ['icon', info?.icons],
        ['knowledge', tools[0].icons],
        ['issues', tools[1].icons],
      ] as const) {
        expect(icons).toHaveLength(1);
        expect(icons?.[0]).toMatchObject({ mimeType: 'image/svg+xml', sizes: ['any'] });
        expect(icons?.[0].src).toMatch(/^data:image\/svg\+xml;base64,/u);
        const svg = Buffer.from(icons![0].src.split(',')[1], 'base64').toString('utf8');
        expect(svg).toBe(readFileSync(new URL(`../plugins/horizonlayer/assets/${name}.svg`, import.meta.url), 'utf8'));
      }
    } finally {
      await client.close();
      await server.stop();
    }
  });

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
