import { normalizeSecurityPolicyPayload } from './security-policy-normalizer';
import type { SecurityPolicyPayload } from './security-policy-types';

export function createSecurityEmergencyLockdownPayload(value: unknown): SecurityPolicyPayload {
  const current = normalizeSecurityPolicyPayload(value);
  return normalizeSecurityPolicyPayload({
    ...current,
    preset: 'strict',
    runtime: {
      ...current.runtime,
      autoHarden: true,
      monitors: {
        credentials: true,
        memory: true,
        cost: true,
      },
      auditOnGatewayStart: true,
      runtimeGuardEnabled: true,
      enablePromptInjectionGuard: true,
      blockDestructive: true,
      blockSecrets: true,
      auditFailureMode: 'block_all',
      logging: {
        logDetections: true,
      },
      destructive: {
        ...current.runtime.destructive,
        action: 'block',
        severityActions: {
          critical: 'block',
          high: 'block',
          medium: 'block',
          low: 'block',
        },
      },
      secrets: {
        ...current.runtime.secrets,
        action: 'block',
        severityActions: {
          critical: 'block',
          high: 'block',
          medium: 'block',
          low: 'block',
        },
      },
    },
  });
}
