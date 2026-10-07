import { describe, expect, it, vi } from 'vitest';
import { semanticPrerequisite } from './prerequisites.js';

describe('semantic benchmark prerequisites', () => {
  it('blocks a missing dedicated URL before inspecting a default or caller-owned service', async () => {
    const readVersion = vi.fn();
    await expect(semanticPrerequisite(undefined, readVersion)).rejects.toMatchObject({
      code: 'DEPENDENCY_UNAVAILABLE', dependency: 'qdrant', retryable: false,
    });
    expect(readVersion).not.toHaveBeenCalled();
  });
  it('classifies a refused or rejected version request without disclosing its raw error', async () => {
    const secret = 'hypothetical-sensitive-header';
    const error = await semanticPrerequisite('http://127.0.0.1:6333',
      async () => { throw new Error(secret); }).catch((error: Error) => error);
    expect(error).toMatchObject({ code: 'DEPENDENCY_UNAVAILABLE', dependency: 'qdrant', retryable: true });
    expect((error as Error).message).not.toContain(secret);
  });
  it('returns the real service metadata unchanged when ready', async () => {
    const version = { version: '1.18.2' };
    await expect(semanticPrerequisite('http://127.0.0.1:6333', async () => version)).resolves.toBe(version);
  });
});
