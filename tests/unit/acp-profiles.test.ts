import { describe, expect, it } from 'vitest';
import { acpEndpointTemplates } from '../../runtime-host/application/agent-runtime/protocol-connectors/acp/acp-profiles';

describe('ACP runtime endpoint profiles', () => {
  it('declares Claude Code and Hermes as ACP endpoint templates', () => {
    expect(acpEndpointTemplates).toMatchObject([
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
