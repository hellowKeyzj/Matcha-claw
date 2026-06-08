import { beforeEach, describe, expect, it } from 'vitest';
import {
  gatewayClientRpcMock,
  hostApiFetchMock,
  resetGatewayClientMocks,
} from './helpers/mock-gateway-client';
import { useSubagentsStore } from '@/stores/subagents';

describe('subagents default agent', () => {
  beforeEach(() => {
    resetGatewayClientMocks();
    useSubagentsStore.setState(useSubagentsStore.getInitialState(), true);
  });

  it('loadAgents 以 agents.list.defaultId 作为默认标记，不强制 main 为默认', async () => {
    gatewayClientRpcMock.mockImplementation(async (method) => {
      if (method === 'agents.list') {
        return {
          success: true,
          result: {
            agents: [
              { id: 'main', name: 'Main' },
              { id: 'writer', name: 'Writer' },
            ],
            defaultId: 'writer',
            mainKey: 'main',
            scope: 'per-sender',
          },
        };
      }
      if (method === 'config.get') {
        return {
          success: true,
          result: {
            hash: 'hash-default',
            config: {
              agents: {
                list: [
                  { id: 'main', name: 'Main', default: false },
                  { id: 'writer', name: 'Writer', default: true },
                ],
              },
            },
          },
        };
      }
      throw new Error(`Unexpected gateway rpc method: ${String(method)}`);
    });

    await useSubagentsStore.getState().loadAgents();

    expect(useSubagentsStore.getState().agents).toEqual([
      {
        id: 'main',
        name: 'Main',
        workspace: undefined,
        model: undefined,
        isDefault: false,
      },
      {
        id: 'writer',
        name: 'Writer',
        workspace: undefined,
        model: undefined,
        isDefault: true,
      },
    ]);
    expect(hostApiFetchMock).not.toHaveBeenCalledWith('/api/subagents/list', expect.anything());
    expect(hostApiFetchMock).not.toHaveBeenCalledWith('/api/subagents/config/get', expect.anything());
  });
});
