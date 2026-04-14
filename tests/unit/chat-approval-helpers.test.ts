import { describe, expect, it } from 'vitest';
import {
  normalizeApprovalDecision,
  normalizeApprovalTimestampMs,
  parseGatewayApprovalResponse,
  resolveApprovalSessionKey,
} from '@/stores/chat/approval-helpers';

describe('chat approval helpers', () => {
  it('normalizes approval decision variants', () => {
    expect(normalizeApprovalDecision('allow_once')).toBe('allow-once');
    expect(normalizeApprovalDecision('ALLOW-ALWAYS')).toBe('allow-always');
    expect(normalizeApprovalDecision('deny')).toBe('deny');
    expect(normalizeApprovalDecision('unknown')).toBeUndefined();
  });

  it('resolves approval session key from direct and nested payload', () => {
    expect(resolveApprovalSessionKey({ sessionKey: 'agent:main:main' })).toBe('agent:main:main');
    expect(resolveApprovalSessionKey({ request: { sessionKey: 'agent:foo:main' } })).toBe('agent:foo:main');
    expect(resolveApprovalSessionKey({})).toBeUndefined();
  });

  it('normalizes approval timestamp in seconds and milliseconds', () => {
    expect(normalizeApprovalTimestampMs(1_700_000_000)).toBe(1_700_000_000_000);
    expect(normalizeApprovalTimestampMs(1_700_000_000_123)).toBe(1_700_000_000_123);
    expect(normalizeApprovalTimestampMs('1700')).toBeUndefined();
  });

  it('parses gateway approval payload and deduplicates by session/id', () => {
    const now = Date.now();
    const parsed = parseGatewayApprovalResponse({
      approvals: [
        {
          id: 'approval-a',
          sessionKey: 'agent:main:main',
          createdAt: now - 1_000,
        },
        {
          id: 'approval-a',
          sessionKey: 'agent:main:main',
          createdAt: now,
        },
        {
          approvalId: 'approval-b',
          request: {
            sessionKey: 'agent:foo:main',
            requestedAt: now - 500,
          },
        },
      ],
    });

    expect(parsed.recognized).toBe(true);
    expect(parsed.items).toHaveLength(2);
    expect(parsed.items.some((item) => item.id === 'approval-a' && item.sessionKey === 'agent:main:main')).toBe(true);
    expect(parsed.items.some((item) => item.id === 'approval-b' && item.sessionKey === 'agent:foo:main')).toBe(true);
  });

  it('returns unrecognized for unrelated payload', () => {
    const parsed = parseGatewayApprovalResponse({ hello: 'world' });
    expect(parsed).toEqual({ recognized: false, items: [] });
  });
});

