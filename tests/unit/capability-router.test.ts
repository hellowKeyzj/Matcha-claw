import { describe, expect, it, vi } from 'vitest';
import type { RuntimeAddress } from '../../runtime-host/application/agent-runtime/contracts/runtime-address';
import type { CapabilityDescriptor } from '../../runtime-host/application/capabilities/contracts/capability-descriptor';
import { CapabilityRouter } from '../../runtime-host/application/capabilities/contracts/capability-router';

const claudeCodeAddress: RuntimeAddress = {
  kind: 'protocol-connector',
  capabilityId: 'session.prompt',
  protocolId: 'acp',
  connectorId: 'acp',
  endpointId: 'claude-code',
  agentId: 'default',
};

const approvalAddress: RuntimeAddress = {
  ...claudeCodeAddress,
  capabilityId: 'session.approval',
};

const hermesAddress: RuntimeAddress = {
  ...claudeCodeAddress,
  endpointId: 'hermes',
};

const modelAddress: RuntimeAddress = {
  ...claudeCodeAddress,
  capabilityId: 'session.modelSelection',
};

const toolAddress: RuntimeAddress = {
  ...claudeCodeAddress,
  capabilityId: 'tool.invoke',
};

function operationsForCapability(capabilityId: string): CapabilityDescriptor['operations'] {
  if (capabilityId === 'session.approval') {
    return [
      { id: 'approvals.list', title: 'List approvals' },
      { id: 'approvals.resolve', title: 'Resolve approval' },
    ];
  }
  if (capabilityId === 'session.modelSelection') {
    return [
      { id: 'sessions.patchModel', title: 'Patch session model' },
    ];
  }
  if (capabilityId === 'tool.invoke') {
    return [
      { id: 'tools.invoke', title: 'Invoke tool' },
    ];
  }
  return [
    { id: 'sessions.create', title: 'Create session' },
    { id: 'sessions.load', title: 'Load session' },
    { id: 'sessions.prompt', title: 'Prompt session' },
    { id: 'sessions.abort', title: 'Abort session' },
  ];
}

function descriptor(address: RuntimeAddress): CapabilityDescriptor {
  return {
    id: address.capabilityId,
    kind: 'session',
    address,
    ...(address.kind === 'native-runtime'
      ? {
        runtimeAdapterId: address.runtimeAdapterId,
        runtimeInstanceId: address.runtimeInstanceId,
      }
      : {
        protocolId: address.protocolId,
        connectorId: address.connectorId,
        endpointId: address.endpointId,
      }),
    targetAgentIds: [address.agentId],
    supportLevel: 'native',
    availability: 'available',
    operations: operationsForCapability(address.capabilityId),
    policyScope: address.capabilityId,
    ownerModuleId: address.kind === 'native-runtime' ? address.runtimeAdapterId : address.connectorId,
    routeOwnerId: 'sessions',
  };
}

describe('CapabilityRouter', () => {
  it('rejects duplicate operation routes for the same capability operation', () => {
    const handle = vi.fn(async () => ({ status: 200, data: {} }));

    expect(() => new CapabilityRouter({
      getCapability: () => descriptor(claudeCodeAddress),
      operations: [
        {
          capabilityId: 'session.prompt',
          operationId: 'sessions.prompt',
          handle,
        },
        {
          capabilityId: 'session.prompt',
          operationId: 'sessions.prompt',
          handle,
        },
      ],
    })).toThrow('Capability operation route already registered: session.prompt:sessions.prompt');
  });

  it('executes declared session.prompt operation with exact RuntimeAddress in payload', async () => {
    const capability = descriptor(claudeCodeAddress);
    const handle = vi.fn(async (payload: unknown) => ({ status: 200, data: { payload } }));
    const router = new CapabilityRouter({
      getCapability: (input) => {
        expect(input).toEqual({ id: 'session.prompt', address: claudeCodeAddress });
        return capability;
      },
      operations: [
        {
          capabilityId: 'session.prompt',
          operationId: 'sessions.prompt',
          handle,
        },
      ],
    });

    const response = await router.execute({
      id: 'session.prompt',
      operationId: 'sessions.prompt',
      address: claudeCodeAddress,
      input: {
        sessionKey: 'claude-code:session:1',
        message: 'hello',
        runtimeAddress: claudeCodeAddress,
      },
    });

    expect(response).toEqual({
      status: 200,
      data: {
        payload: {
          capabilityId: 'session.prompt',
          operationId: 'sessions.prompt',
          address: claudeCodeAddress,
          input: {
            sessionKey: 'claude-code:session:1',
            message: 'hello',
            runtimeAddress: claudeCodeAddress,
          },
          domainInput: {
            sessionKey: 'claude-code:session:1',
            message: 'hello',
          },
        },
      },
    });
    expect(handle).toHaveBeenCalledTimes(1);
  });

  it('executes declared session.approval operation with exact RuntimeAddress in payload', async () => {
    const handle = vi.fn(async (payload: unknown) => ({ status: 200, data: { payload } }));
    const router = new CapabilityRouter({
      getCapability: (input) => {
        expect(input).toEqual({ id: 'session.approval', address: approvalAddress });
        return descriptor(approvalAddress);
      },
      operations: [
        {
          capabilityId: 'session.approval',
          operationId: 'approvals.resolve',
          handle,
        },
      ],
    });

    await expect(router.execute({
      id: 'session.approval',
      operationId: 'approvals.resolve',
      address: approvalAddress,
      input: {
        id: 'approval-1',
        sessionKey: 'claude-code:session:1',
        decision: 'allow-once',
        runtimeAddress: approvalAddress,
      },
    })).resolves.toEqual({
      status: 200,
      data: {
        payload: {
          capabilityId: 'session.approval',
          operationId: 'approvals.resolve',
          address: approvalAddress,
          input: {
            id: 'approval-1',
            sessionKey: 'claude-code:session:1',
            decision: 'allow-once',
            runtimeAddress: approvalAddress,
          },
          domainInput: {
            id: 'approval-1',
            sessionKey: 'claude-code:session:1',
            decision: 'allow-once',
          },
        },
      },
    });
  });

  it('executes declared session.approval list operation without requiring input fields', async () => {
    const handle = vi.fn(async (payload: unknown) => ({ status: 200, data: { payload } }));
    const router = new CapabilityRouter({
      getCapability: () => descriptor(approvalAddress),
      operations: [
        {
          capabilityId: 'session.approval',
          operationId: 'approvals.list',
          handle,
        },
      ],
    });

    await expect(router.execute({
      id: 'session.approval',
      operationId: 'approvals.list',
      address: approvalAddress,
      input: {
        runtimeAddress: approvalAddress,
      },
    })).resolves.toEqual({
      status: 200,
      data: {
        payload: {
          capabilityId: 'session.approval',
          operationId: 'approvals.list',
          address: approvalAddress,
          input: {
            runtimeAddress: approvalAddress,
          },
          domainInput: {},
        },
      },
    });
  });

  it('executes declared session model-selection operation with exact RuntimeAddress in payload', async () => {
    const handle = vi.fn(async (payload: unknown) => ({ status: 200, data: { payload } }));
    const router = new CapabilityRouter({
      getCapability: (input) => {
        expect(input).toEqual({ id: 'session.modelSelection', address: modelAddress });
        return descriptor(modelAddress);
      },
      operations: [
        {
          capabilityId: 'session.modelSelection',
          operationId: 'sessions.patchModel',
          handle,
        },
      ],
    });

    await expect(router.execute({
      id: 'session.modelSelection',
      operationId: 'sessions.patchModel',
      address: modelAddress,
      input: {
        sessionKey: 'claude-code:session:1',
        runtimeModelRef: 'anthropic/claude-opus-4-6',
        runtimeAddress: modelAddress,
      },
    })).resolves.toEqual({
      status: 200,
      data: {
        payload: {
          capabilityId: 'session.modelSelection',
          operationId: 'sessions.patchModel',
          address: modelAddress,
          input: {
            sessionKey: 'claude-code:session:1',
            runtimeModelRef: 'anthropic/claude-opus-4-6',
            runtimeAddress: modelAddress,
          },
          domainInput: {
            sessionKey: 'claude-code:session:1',
            runtimeModelRef: 'anthropic/claude-opus-4-6',
          },
        },
      },
    });
  });

  it('executes declared tool.invoke operation with exact RuntimeAddress in payload', async () => {
    const handle = vi.fn(async (payload: unknown) => ({ status: 200, data: { payload } }));
    const router = new CapabilityRouter({
      getCapability: (input) => {
        expect(input).toEqual({ id: 'tool.invoke', address: toolAddress });
        return descriptor(toolAddress);
      },
      operations: [
        {
          capabilityId: 'tool.invoke',
          operationId: 'tools.invoke',
          handle,
        },
      ],
    });

    await expect(router.execute({
      id: 'tool.invoke',
      operationId: 'tools.invoke',
      address: toolAddress,
      input: {
        method: 'TaskList',
        params: { sessionKey: 'claude-code:session:1' },
        runtimeAddress: toolAddress,
      },
    })).resolves.toEqual({
      status: 200,
      data: {
        payload: {
          capabilityId: 'tool.invoke',
          operationId: 'tools.invoke',
          address: toolAddress,
          input: {
            method: 'TaskList',
            params: { sessionKey: 'claude-code:session:1' },
            runtimeAddress: toolAddress,
          },
          domainInput: {
            method: 'TaskList',
            params: { sessionKey: 'claude-code:session:1' },
          },
        },
      },
    });
  });

  it('rejects an execute request whose RuntimeAddress is malformed before registry lookup', async () => {
    const getCapability = vi.fn(() => descriptor(claudeCodeAddress));
    const handle = vi.fn(async () => ({ status: 200, data: {} }));
    const router = new CapabilityRouter({
      getCapability,
      operations: [
        {
          capabilityId: 'session.prompt',
          operationId: 'sessions.prompt',
          handle,
        },
      ],
    });

    await expect(router.execute({
      id: 'session.prompt',
      operationId: 'sessions.prompt',
      address: {
        kind: 'protocol-connector',
        capabilityId: 'session.prompt',
        protocolId: 'acp',
        connectorId: 'acp',
        endpointId: 'claude-code',
      } as RuntimeAddress,
      input: { runtimeAddress: claudeCodeAddress },
    })).resolves.toEqual({
      status: 400,
      data: { success: false, error: 'RuntimeAddress agentId is required' },
    });
    expect(getCapability).not.toHaveBeenCalled();
    expect(handle).not.toHaveBeenCalled();
  });

  it('rejects an execute request whose id differs from RuntimeAddress capabilityId', async () => {
    const getCapability = vi.fn(() => descriptor(claudeCodeAddress));
    const handle = vi.fn(async () => ({ status: 200, data: {} }));
    const router = new CapabilityRouter({
      getCapability,
      operations: [
        {
          capabilityId: 'session.prompt',
          operationId: 'sessions.prompt',
          handle,
        },
      ],
    });

    await expect(router.execute({
      id: 'tool.invoke',
      operationId: 'sessions.prompt',
      address: claudeCodeAddress,
      input: { runtimeAddress: claudeCodeAddress },
    })).resolves.toEqual({
      status: 400,
      data: { success: false, error: 'Capability id does not match RuntimeAddress capabilityId' },
    });
    expect(getCapability).not.toHaveBeenCalled();
    expect(handle).not.toHaveBeenCalled();
  });

  it('rejects capability execution input without a RuntimeAddress', async () => {
    const handle = vi.fn(async () => ({ status: 200, data: {} }));
    const router = new CapabilityRouter({
      getCapability: () => descriptor(claudeCodeAddress),
      operations: [
        {
          capabilityId: 'session.prompt',
          operationId: 'sessions.prompt',
          handle,
        },
      ],
    });

    await expect(router.execute({
      id: 'session.prompt',
      operationId: 'sessions.prompt',
      address: claudeCodeAddress,
      input: {
        sessionKey: 'claude-code:session:1',
      },
    })).resolves.toEqual({
      status: 400,
      data: { success: false, error: 'Capability input RuntimeAddress is required' },
    });
    expect(handle).not.toHaveBeenCalled();
  });

  it('rejects an input RuntimeAddress that differs from the execute request address', async () => {
    const handle = vi.fn(async () => ({ status: 200, data: {} }));
    const router = new CapabilityRouter({
      getCapability: () => descriptor(claudeCodeAddress),
      operations: [
        {
          capabilityId: 'session.prompt',
          operationId: 'sessions.prompt',
          handle,
        },
      ],
    });

    await expect(router.execute({
      id: 'session.prompt',
      operationId: 'sessions.prompt',
      address: claudeCodeAddress,
      input: {
        sessionKey: 'claude-code:session:1',
        runtimeAddress: hermesAddress,
      },
    })).resolves.toEqual({
      status: 400,
      data: { success: false, error: 'Capability input RuntimeAddress does not match request RuntimeAddress' },
    });
    expect(handle).not.toHaveBeenCalled();
  });

  it('rejects a descriptor RuntimeAddress that differs from the execute request address', async () => {
    const handle = vi.fn(async () => ({ status: 200, data: {} }));
    const router = new CapabilityRouter({
      getCapability: () => descriptor(hermesAddress),
      operations: [
        {
          capabilityId: 'session.prompt',
          operationId: 'sessions.prompt',
          handle,
        },
      ],
    });

    await expect(router.execute({
      id: 'session.prompt',
      operationId: 'sessions.prompt',
      address: claudeCodeAddress,
      input: { runtimeAddress: claudeCodeAddress },
    })).resolves.toEqual({
      status: 400,
      data: { success: false, error: 'Capability descriptor RuntimeAddress does not match request RuntimeAddress' },
    });
    expect(handle).not.toHaveBeenCalled();
  });

  it('rejects operations not declared by the descriptor', async () => {
    const router = new CapabilityRouter({
      getCapability: () => ({
        ...descriptor(claudeCodeAddress),
        operations: [{ id: 'sessions.prompt', title: 'Prompt session' }],
      }),
      operations: [
        {
          capabilityId: 'session.prompt',
          operationId: 'tools.invoke',
          handle: async () => ({ status: 200, data: {} }),
        },
      ],
    });

    await expect(router.execute({
      id: 'session.prompt',
      operationId: 'tools.invoke',
      address: claudeCodeAddress,
      input: { runtimeAddress: claudeCodeAddress },
    })).resolves.toEqual({
      status: 400,
      data: { success: false, error: 'Capability operation not supported: tools.invoke' },
    });
  });

  it('indexes descriptor operations per descriptor instance', async () => {
    const operationIterator = vi.fn(function* () {
      yield { id: 'sessions.prompt', title: 'Prompt session' };
    });
    const capability = {
      ...descriptor(claudeCodeAddress),
      operations: {
        [Symbol.iterator]: operationIterator,
        map: (mapper: (operation: { id: string; title: string }) => string) => Array.from(operationIterator(), mapper),
      } as CapabilityDescriptor['operations'],
    };
    const router = new CapabilityRouter({
      getCapability: () => capability,
      operations: [
        {
          capabilityId: 'session.prompt',
          operationId: 'sessions.prompt',
          handle: async () => ({ status: 200, data: { ok: true } }),
        },
      ],
    });

    await router.execute({
      id: 'session.prompt',
      operationId: 'sessions.prompt',
      address: claudeCodeAddress,
      input: { runtimeAddress: claudeCodeAddress },
    });
    await router.execute({
      id: 'session.prompt',
      operationId: 'sessions.prompt',
      address: claudeCodeAddress,
      input: { runtimeAddress: claudeCodeAddress },
    });

    expect(operationIterator).toHaveBeenCalledTimes(1);
  });

  it('rejects declared operations without a registered executor', async () => {
    const router = new CapabilityRouter({
      getCapability: () => descriptor(claudeCodeAddress),
      operations: [],
    });

    await expect(router.execute({
      id: 'session.prompt',
      operationId: 'sessions.prompt',
      address: claudeCodeAddress,
      input: { runtimeAddress: claudeCodeAddress },
    })).resolves.toEqual({
      status: 400,
      data: { success: false, error: 'Capability execution not supported: session.prompt' },
    });
  });
});
