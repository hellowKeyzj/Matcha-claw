import { describe, expect, it } from 'vitest';
import {
  resolveMainWorkspaceDir,
  resolveWorkspaceDirForSession,
} from '../../runtime-host/application/openclaw/openclaw-workspace-rules';

describe('runtime-host openclaw workspace rules', () => {
  it('resolves main sessions to the main workspace', () => {
    const config = {
      agents: {
        defaults: {
          workspace: '/home/dev/.openclaw/workspace',
        },
      },
    };

    expect(resolveWorkspaceDirForSession(config, '/home/dev/.openclaw', 'agent:main:main'))
      .toBe(resolveMainWorkspaceDir(config, '/home/dev/.openclaw'));
  });

  it('resolves configured subagent sessions to the configured workspace', () => {
    const config = {
      agents: {
        list: [
          { id: 'main', workspace: 'C:\\Users\\Dev\\.openclaw\\workspace' },
          { id: 'ui-designer', workspace: 'C:\\Users\\Dev\\custom-ui-designer' },
        ],
      },
    };

    expect(resolveWorkspaceDirForSession(
      config,
      'C:\\Users\\Dev\\.openclaw',
      'agent:ui-designer:session-1',
    )).toBe('C:\\Users\\Dev\\custom-ui-designer');
  });

  it('falls back subagent sessions to configDir/workspace-subagents/<agentId>', () => {
    expect(resolveWorkspaceDirForSession(
      {},
      'C:\\Users\\Dev\\.openclaw',
      'agent:ui-designer:session-1',
    )).toBe('C:\\Users\\Dev\\.openclaw\\workspace-subagents\\ui-designer');
  });
});
