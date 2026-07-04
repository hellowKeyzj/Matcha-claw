import { describe, expect, it } from 'vitest';
import { validateExternalConnectorSpec } from '../../runtime-host/application/external-connectors/external-connector-model';

function expectInvalid(input: unknown): string {
  const result = validateExternalConnectorSpec(input);
  expect(result.resultType).toBe('invalid');
  return result.resultType === 'invalid' ? result.reason : '';
}

describe('validateExternalConnectorSpec', () => {
  it('accepts common protocol connector specs', () => {
    const specs = [
      {
        id: 'matcha',
        kind: 'mcp-stdio',
        command: 'matcha',
        args: ['system-runtime', 'mcp-stdio'],
        mcpServerProgram: { source: 'system-runtime', programId: 'system-runtime:matcha' },
      },
      { id: 'github-mcp', kind: 'mcp-stdio', command: 'npx', args: ['github-mcp'] },
      { id: 'docs', kind: 'mcp-http', url: 'https://mcp.example.com', transport: 'streamable-http' },
      { id: 'gh-cli', kind: 'cli', command: 'gh', args: ['issue', 'list'] },
      { id: 'stripe', kind: 'sdk', provider: 'stripe', packageName: 'stripe', config: { apiVersion: '2025-01-01' } },
      { id: 'notion', kind: 'http', baseUrl: 'https://api.notion.com' },
    ];

    for (const spec of specs) {
      expect(validateExternalConnectorSpec(spec)).toMatchObject({ resultType: 'valid' });
    }
  });

  it('rejects public secret-bearing fields', () => {
    expect(expectInvalid({
      id: 'secret-http',
      kind: 'mcp-http',
      url: 'https://mcp.example.com',
      headers: { Authorization: 'Bearer raw-token' },
    })).toContain('use the matching secret* field instead');

    expect(expectInvalid({
      id: 'secret-sdk',
      kind: 'sdk',
      provider: 'stripe',
      config: { apiKey: 'raw-key' },
    })).toContain('use secretConfigRefs instead');
  });

  it('rejects process env keys that alter startup behavior', () => {
    expect(expectInvalid({
      id: 'unsafe-node',
      kind: 'mcp-stdio',
      command: 'node',
      env: { NODE_OPTIONS: '--require ./prelude.js' },
    })).toContain('blocked because it can change process startup behavior');
  });
});
