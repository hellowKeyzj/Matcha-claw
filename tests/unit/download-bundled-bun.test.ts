import { describe, expect, it } from 'vitest';
import { canReuseCachedBun, localFunctionalBunCacheEvidence } from '../../scripts/download-bundled-bun.mjs';

const x64Pe = Buffer.alloc(0x100);
x64Pe.writeUInt32LE(0x80, 0x3c);
x64Pe.writeUInt16LE(0x8664, 0x84);

const arm64Pe = Buffer.alloc(0x100);
arm64Pe.writeUInt32LE(0x80, 0x3c);
arm64Pe.writeUInt16LE(0xaa64, 0x84);

function dependencies({ stdout = '1.4.2\n', status = 0, binary = x64Pe } = {}) {
  return {
    existsSync: () => true,
    spawnSync: () => ({ status, stdout }),
    readFileSync: () => binary,
  };
}

describe('bundled Bun cache', () => {
  it('recognizes only the exact pinned Windows x64 Bun executable as a functional cache match', () => {
    expect(canReuseCachedBun({ executablePath: 'C:/cache/bun.exe', targetId: 'win32-x64' }, dependencies())).toBe(true);
    expect(localFunctionalBunCacheEvidence({ executablePath: 'C:/cache/bun.exe', targetId: 'win32-x64' }, dependencies())).toEqual({
      source: 'local-cache',
      target: 'win32-x64',
      functionalMatch: 'exact-bun-1.4.2-win32-x64-pe',
      independentProvenance: 'unverified',
      supplyChainAttestation: 'not-present',
    });
  });

  it('rejects a cache with a mismatched version, unreadable binary, or wrong Windows architecture', () => {
    expect(canReuseCachedBun({ executablePath: 'C:/cache/bun.exe', targetId: 'win32-x64' }, dependencies({ stdout: '1.3.4\n' }))).toBe(false);
    expect(localFunctionalBunCacheEvidence({ executablePath: 'C:/cache/bun.exe', targetId: 'win32-x64' }, dependencies({ stdout: '1.3.4\n' }))).toBeUndefined();
    expect(canReuseCachedBun({ executablePath: 'C:/cache/bun.exe', targetId: 'win32-x64' }, dependencies({ binary: arm64Pe }))).toBe(false);
    expect(canReuseCachedBun({ executablePath: 'C:/cache/bun.exe', targetId: 'win32-x64' }, {
      existsSync: () => true,
      spawnSync: () => ({ status: 0, stdout: '1.4.2\n' }),
      readFileSync: () => { throw new Error('unreadable'); },
    })).toBe(false);
  });

  it('rejects a missing or non-executable cache before any architecture read', () => {
    expect(canReuseCachedBun({ executablePath: 'C:/cache/bun.exe', targetId: 'win32-x64' }, {
      existsSync: () => false,
      spawnSync: () => { throw new Error('must not execute'); },
      readFileSync: () => { throw new Error('must not read'); },
    })).toBe(false);
    expect(canReuseCachedBun({ executablePath: 'C:/cache/bun.exe', targetId: 'win32-x64' }, dependencies({ status: 1 }))).toBe(false);
  });
});
