import { readFileSync } from 'node:fs';
import type { Icon } from '@modelcontextprotocol/sdk/types.js';

// Inline the packaged artwork so stdio clients need no HTTP server or network fetch.
function icon(name: string): Icon[] {
  const svg = readFileSync(new URL(`../plugins/horizonlayer/assets/${name}.svg`, import.meta.url));
  return [{ src: `data:image/svg+xml;base64,${svg.toString('base64')}`, mimeType: 'image/svg+xml', sizes: ['any'] }];
}

export const horizonLayerIcons = icon('icon');
export const knowledgeIcons = icon('knowledge');
export const issuesIcons = icon('issues');
