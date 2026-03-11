import { describe, expect, it } from 'vitest';
import { homedir } from 'node:os';
import { join, resolve as resolvePath } from 'node:path';
import { resolveMainWorkspaceDir, resolveTaskWorkspaceDirs } from '@electron/utils/task-workspace-scope';

describe('task workspace scope resolver', () => {
  const configDir = resolvePath('.openclaw-test');
  const fallbackMain = resolvePath(join(configDir, 'workspace'));

  it('主 workspace 缺失时回退到 ~/.openclaw/workspace 风格目录（基于 configDir）', () => {
    const config = {
      agents: {
        defaults: {},
        list: [{ id: 'main' }],
      },
    };

    expect(resolveMainWorkspaceDir(config, configDir)).toBe(fallbackMain);
  });

  it('scope 始终包含主 workspace，并合并子代理 workspace', () => {
    const sub1 = resolvePath(join(configDir, 'workspace-subagents', 'test'));
    const sub2 = resolvePath(join(configDir, 'workspace-subagents', 'test222'));
    const config = {
      agents: {
        defaults: {},
        list: [
          { id: 'main' },
          { id: 'test', workspace: sub1 },
          { id: 'test222', workspace: sub2 },
        ],
      },
    };

    const dirs = resolveTaskWorkspaceDirs(config, configDir);
    expect(dirs).toContain(fallbackMain);
    expect(dirs).toContain(sub1);
    expect(dirs).toContain(sub2);
  });

  it('defaults.workspace 存在时优先使用，并对 ~ 做展开', () => {
    const config = {
      agents: {
        defaults: {
          workspace: '~/.openclaw/custom-main-workspace',
        },
        list: [{ id: 'main' }],
      },
    };

    const expected = resolvePath(join(homedir(), '.openclaw', 'custom-main-workspace'));
    expect(resolveMainWorkspaceDir(config, configDir)).toBe(expected);
  });
});
