import { describe, expect, it } from 'vitest';
import {
  buildSubagentWorkspacePath,
  hasSubagentNameConflict,
  normalizeSubagentNameToSlug,
  resolveSubagentWorkspaceRoot,
} from '@/lib/subagent-workspace';

describe('subagent workspace path', () => {
  it('resolves root from main workspace using unix separator', () => {
    const root = resolveSubagentWorkspaceRoot([
      { id: 'main', workspace: '/home/dev/.openclaw/workspace' },
    ]);
    expect(root).toBe('/home/dev/.openclaw/workspace-subagents');
  });

  it('resolves root from main workspace using windows separator', () => {
    const root = resolveSubagentWorkspaceRoot([
      { id: 'main', workspace: 'C:\\Users\\Dev\\.openclaw\\workspace' },
    ]);
    expect(root).toBe('C:\\Users\\Dev\\.openclaw\\workspace-subagents');
  });

  it('uses fallback root when main workspace is unavailable', () => {
    const root = resolveSubagentWorkspaceRoot([{ id: 'main' }]);
    expect(root).toBe('~/.openclaw/workspace-subagents');
  });

  it('builds workspace path with slugified name', () => {
    const workspace = buildSubagentWorkspacePath({
      name: 'Writer Bot',
      agents: [
        { id: 'main', workspace: '/home/dev/.openclaw/workspace' },
        { id: 'alpha', workspace: '/home/dev/.openclaw/workspace-subagents/alpha' },
      ],
    });
    expect(workspace).toBe('/home/dev/.openclaw/workspace-subagents/writer-bot');
  });

  it('builds fallback path and default slug for empty name', () => {
    const workspace = buildSubagentWorkspacePath({
      name: '',
      agents: [{ id: 'main' }],
    });
    expect(workspace).toBe('~/.openclaw/workspace-subagents/agent');
  });

  it('detects duplicate name conflicts by slug', () => {
    expect(
      hasSubagentNameConflict('Writer Bot', [{ id: 'main' }, { id: 'writer-bot' }])
    ).toBe(true);
    expect(
      hasSubagentNameConflict('writer-bot', [{ id: 'main' }, { id: 'writer-bot' }], {
        excludeAgentId: 'writer-bot',
      })
    ).toBe(false);
  });

  it('normalizes name to slug', () => {
    expect(normalizeSubagentNameToSlug('  Matcha Agent 2  ')).toBe('matcha-agent-2');
  });
});
