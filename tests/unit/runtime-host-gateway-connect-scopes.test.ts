import { describe, expect, it } from 'vitest';
import { DEFAULT_GATEWAY_OPERATOR_SCOPES } from '../../runtime-host/openclaw-bridge/client';

describe('runtime-host gateway connect scopes', () => {
  it('默认 scope bundle 包含 read/write，避免 agents.list 与 skills.status 缺少权限', () => {
    expect(DEFAULT_GATEWAY_OPERATOR_SCOPES).toContain('operator.read');
    expect(DEFAULT_GATEWAY_OPERATOR_SCOPES).toContain('operator.write');
    expect(DEFAULT_GATEWAY_OPERATOR_SCOPES).toContain('operator.approvals');
  });
});
