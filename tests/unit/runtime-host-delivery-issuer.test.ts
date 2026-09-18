import { describe, expect, it } from 'vitest';
import {
  createRuntimeHostDeliveryIssuer,
} from '../../electron/main/runtime-host-delivery/issuer';

describe('RuntimeHostDeliveryIssuer', () => {
  it('signs a short-lived fixed decision without exposing its private key', () => {
    const issuer = createRuntimeHostDeliveryIssuer();
    const decision = issuer.signDecision({
      principal: 'desktop-session:fixture',
      endpoint: '/api/sessions',
      scope: 'sessions:read',
      capability: 'sessions.list',
      subject: 'session-catalog',
      expiresAt: Date.now() + 30_000,
      revision: 'revision:fixture',
    });

    expect(issuer.verificationKey).toMatch(/^[A-Za-z0-9_-]{59}$/);
    expect(decision).toMatch(/^capability-decision\.v1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);
    expect(JSON.stringify(issuer)).not.toContain('private');
    expect(JSON.stringify(issuer)).not.toContain('keyObject');
  });

  it('rejects expired and malformed decision input before signing', () => {
    const issuer = createRuntimeHostDeliveryIssuer();
    expect(() => issuer.signDecision({
      principal: 'desktop-session:fixture',
      endpoint: '/api/sessions',
      scope: 'sessions:read',
      capability: 'sessions.list',
      subject: 'session-catalog',
      expiresAt: Date.now(),
      revision: 'revision:fixture',
    })).toThrow('Runtime-host capability decision input is invalid.');
  });
});
