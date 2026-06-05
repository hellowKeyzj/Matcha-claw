import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AcpStdioTransport } from '../../runtime-host/application/agent-runtime/protocol-connectors/acp/acp-stdio-transport';
import { claudeCodeAcpEndpointTemplate, hermesAcpEndpointTemplate } from '../../runtime-host/application/agent-runtime/protocol-connectors/acp/acp-profiles';
import { createTestAcpClientConnector } from './helpers/acp-test-connector';

vi.mock('../../runtime-host/application/agent-runtime/protocol-connectors/acp/acp-stdio-transport', () => ({
  AcpStdioTransport: vi.fn(function AcpStdioTransportMock() {
    return {
      stop: vi.fn(),
      inspectReadiness: vi.fn(async () => ({ ready: true, phase: 'ready' })),
    };
  }),
}));

describe('ACP client connector', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('reuses one transport per endpoint until disconnected', () => {
    const connector = createTestAcpClientConnector();

    const first = connector.connect(claudeCodeAcpEndpointTemplate);
    const second = connector.connect(claudeCodeAcpEndpointTemplate);

    expect(first).toBe(second);
    expect(AcpStdioTransport).toHaveBeenCalledTimes(1);
  });

  it('keeps Claude Code and Hermes endpoint transports isolated', () => {
    const connector = createTestAcpClientConnector();

    const claudeCode = connector.connect(claudeCodeAcpEndpointTemplate);
    const hermes = connector.connect(hermesAcpEndpointTemplate);

    expect(claudeCode).not.toBe(hermes);
    expect(AcpStdioTransport).toHaveBeenCalledTimes(2);
    expect(AcpStdioTransport).toHaveBeenNthCalledWith(1, claudeCodeAcpEndpointTemplate);
    expect(AcpStdioTransport).toHaveBeenNthCalledWith(2, hermesAcpEndpointTemplate);
  });

  it('stops cached endpoint transport on disconnect', async () => {
    const connector = createTestAcpClientConnector();
    const transport = connector.connect(claudeCodeAcpEndpointTemplate) as { stop: ReturnType<typeof vi.fn> };

    await expect(connector.inspectEndpointReadiness('claude-code')).resolves.toEqual({ ready: true, phase: 'ready' });
    connector.disconnect('claude-code');

    expect(transport.stop).toHaveBeenCalledTimes(1);
    await expect(connector.inspectEndpointReadiness('claude-code')).resolves.toEqual({
      ready: false,
      phase: 'disconnected',
    });
  });

  it('rejects endpoint lifecycle calls for endpoints outside the ACP connector catalog', async () => {
    const connector = createTestAcpClientConnector();

    expect(() => connector.connect({
      ...claudeCodeAcpEndpointTemplate,
      id: 'foreign',
    })).toThrow('ACP endpoint not registered: foreign');
    expect(() => connector.connect({
      ...claudeCodeAcpEndpointTemplate,
      protocolId: 'other-protocol',
    })).toThrow('ACP endpoint does not belong to connector: claude-code');
    expect(() => connector.disconnect('foreign')).toThrow('ACP endpoint not registered: foreign');
    await expect(connector.inspectEndpointReadiness('foreign')).rejects.toThrow('ACP endpoint not registered: foreign');
  });
});
