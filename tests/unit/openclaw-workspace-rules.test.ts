import { resolve as resolvePath } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  resolveMainWorkspaceDir,
  resolveTaskWorkspaceDirs,
  resolveWorkspaceDirForSession,
} from '../../runtime-host/application/adapters/openclaw/infrastructure/openclaw-workspace-rules';

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

  it('keeps external main, defaults, and listed task workspaces', () => {
    const defaultWorkspace = resolvePath('/home/dev/workspaces/default');
    const mainWorkspace = resolvePath('/home/dev/workspaces/main');
    const reviewerWorkspace = resolvePath('/home/dev/workspaces/reviewer');
    const config = {
      agents: {
        defaults: {
          workspace: defaultWorkspace,
        },
        list: [
          { id: 'main', workspace: mainWorkspace },
          { id: 'reviewer', workspace: reviewerWorkspace },
        ],
      },
    };

    expect(resolveTaskWorkspaceDirs(config, resolvePath('/home/dev/.openclaw'))).toEqual([
      defaultWorkspace,
      mainWorkspace,
      reviewerWorkspace,
    ]);
  });

  it('excludes teambuddy workspaces under the OpenClaw config directory', () => {
    const openclawConfigDir = resolvePath('/home/dev/.openclaw');
    const defaultWorkspace = resolvePath('/home/dev/workspaces/default');
    const mainWorkspace = resolvePath('/home/dev/workspaces/main');
    const config = {
      agents: {
        defaults: {
          workspace: defaultWorkspace,
        },
        list: [
          { id: 'team', workspace: resolvePath(openclawConfigDir, 'teambuddy/team') },
          { id: 'reviewer', workspace: resolvePath(openclawConfigDir, 'teambuddy/team/roles/reviewer') },
          { id: 'main', workspace: mainWorkspace },
        ],
      },
    };

    expect(resolveTaskWorkspaceDirs(config, openclawConfigDir)).toEqual([
      defaultWorkspace,
      mainWorkspace,
    ]);
  });

  it('excludes the TeamBuddy root without excluding other OpenClaw config workspaces', () => {
    const openclawConfigDir = resolvePath('/home/dev/.openclaw');
    const mainWorkspace = resolvePath(openclawConfigDir, 'workspace');
    const configRootWorkspace = openclawConfigDir;
    const config = {
      agents: {
        defaults: {
          workspace: configRootWorkspace,
        },
        list: [
          { id: 'main', workspace: mainWorkspace },
          { id: 'team', workspace: resolvePath(openclawConfigDir, 'teambuddy') },
        ],
      },
    };

    expect(resolveTaskWorkspaceDirs(config, openclawConfigDir)).toEqual([
      configRootWorkspace,
      mainWorkspace,
    ]);
  });

  it('keeps paths with similar prefixes outside the OpenClaw config directory', () => {
    const similarTeambuddyPrefixWorkspace = resolvePath('/home/dev/.openclaw-teambuddy/project');
    const similarMainPrefixWorkspace = resolvePath('/home/dev/.openclaw-main');
    const config = {
      agents: {
        defaults: {
          workspace: similarTeambuddyPrefixWorkspace,
        },
        list: [
          { id: 'main', workspace: similarMainPrefixWorkspace },
        ],
      },
    };

    expect(resolveTaskWorkspaceDirs(config, resolvePath('/home/dev/.openclaw'))).toEqual([
      similarTeambuddyPrefixWorkspace,
      similarMainPrefixWorkspace,
    ]);
  });
});
