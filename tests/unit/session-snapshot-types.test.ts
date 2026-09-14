import { describe, expect, it } from 'vitest';
import type { SessionCatalogKind } from '@/types/session/snapshot';

function acceptSessionCatalogKind(kind: SessionCatalogKind): SessionCatalogKind {
  return kind;
}

describe('session snapshot types', () => {
  it('keeps the final session catalog role set', () => {
    const roles = [
      acceptSessionCatalogKind('main'),
      acceptSessionCatalogKind('subsession'),
      acceptSessionCatalogKind('session'),
      acceptSessionCatalogKind('automation'),
    ];

    expect(roles).toEqual(['main', 'subsession', 'session', 'automation']);
  });

  it('does not keep named as a catalog role alias', () => {
    // @ts-expect-error named is intentionally not part of SessionCatalogKind.
    acceptSessionCatalogKind('named');

    expect(true).toBe(true);
  });
});
