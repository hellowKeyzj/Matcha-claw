import { describe, expect, it } from 'vitest';
import { acpRuntimeProviderProfiles } from '../../runtime-host/application/sessions/runtime-providers/acp/acp-profiles';

describe('ACP runtime provider profiles', () => {
  it('declares Claude Code and Hermes as ACP profiles', () => {
    expect(acpRuntimeProviderProfiles).toMatchObject([
      {
        id: 'claude-code',
        protocolId: 'acp',
        launcher: {
          command: 'npx',
          args: ['--yes', '@zed-industries/claude-code-acp@latest'],
        },
      },
      {
        id: 'hermes',
        protocolId: 'acp',
        launcher: {
          command: 'hermes',
          args: ['acp'],
        },
      },
    ]);
  });
});
