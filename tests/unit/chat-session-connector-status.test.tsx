import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { ChatSessionConnectorStatus } from '@/pages/Chat/components/ChatSessionConnectorStatus';
import { useSessionConnectorStatusStore } from '@/stores/session-connector-status';
import type { SessionIdentity } from '../../runtime-host/shared/runtime-address';

const hostApiFetchMock = vi.fn();
const waitForRuntimeJobResultMock = vi.fn();

vi.mock('@/lib/host-api', () => ({
  hostApiFetch: (...args: unknown[]) => hostApiFetchMock(...args),
  waitForRuntimeJobResult: (...args: unknown[]) => waitForRuntimeJobResultMock(...args),
}));

const sessionIdentity: SessionIdentity = {
  endpoint: {
    kind: 'native-runtime',
    runtimeAdapterId: 'openclaw',
    runtimeInstanceId: 'local',
  },
  agentId: 'agent-1',
  sessionKey: 'session-1',
};

describe('ChatSessionConnectorStatus', () => {
  beforeEach(() => {
    hostApiFetchMock.mockReset();
    waitForRuntimeJobResultMock.mockReset();
    useSessionConnectorStatusStore.setState({
      statusesBySessionKey: {},
      loadingBySessionKey: {},
      errorBySessionKey: {},
    });
  });

  it('rechecks pending session connector status when the OpenClaw MCP status refresh job completes', async () => {
    hostApiFetchMock
      .mockResolvedValueOnce({
        statuses: [{
          connectorId: 'matcha',
          adapterId: 'openclaw',
          targetKind: 'session',
          resultType: 'pending',
          reason: 'OpenClaw MCP status refresh is running in the background',
          details: { refreshJobId: 'job-1' },
        }],
      })
      .mockResolvedValueOnce({
        statuses: [{
          connectorId: 'matcha',
          adapterId: 'openclaw',
          targetKind: 'session',
          resultType: 'connected',
          reason: 'OpenClaw MCP status reported the server as available',
          details: { toolCount: 3 },
        }],
      });

    let resolveRefreshJob: ((value: unknown) => void) | null = null;
    waitForRuntimeJobResultMock.mockReturnValue(new Promise((resolve) => {
      resolveRefreshJob = resolve;
    }));

    render(
      <MemoryRouter>
        <ChatSessionConnectorStatus sessionIdentity={sessionIdentity} />
      </MemoryRouter>,
    );

    await act(async () => {
      await Promise.resolve();
    });
    expect(hostApiFetchMock).toHaveBeenCalledTimes(1);

    expect(waitForRuntimeJobResultMock).toHaveBeenCalledWith('job-1', { endpoint: sessionIdentity.endpoint });

    await act(async () => {
      resolveRefreshJob?.({ resultType: 'available' });
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(hostApiFetchMock).toHaveBeenCalledTimes(2);
    expect(screen.getByRole('button', { name: '会话连接器状态' })).toHaveAttribute('title', '1 个连接器已连接');
  });
});
