import { describe, expect, it, vi } from 'vitest';
import type {
  CapabilityTarget,
  RuntimeEndpointRef,
  RuntimeScope,
  SessionIdentity,
} from '../../runtime-host/application/agent-runtime/contracts/runtime-address';
import type { CapabilityDescriptor, CapabilityOperationDescriptor } from '../../runtime-host/application/capabilities/contracts/capability-descriptor';
import { CapabilityRouter } from '../../runtime-host/application/capabilities/contracts/capability-router';

const connectorEndpoint: RuntimeEndpointRef = {
  kind: 'protocol-connector',
  protocolId: 'acp',
  connectorId: 'acp',
  endpointId: 'claude-code',
};

const hermesEndpoint: RuntimeEndpointRef = {
  ...connectorEndpoint,
  endpointId: 'hermes',
};

const sessionIdentity: SessionIdentity = {
  endpoint: connectorEndpoint,
  agentId: 'default',
  sessionKey: 'claude-code:session:1',
};

const sessionScope: RuntimeScope = {
  kind: 'session',
  identity: sessionIdentity,
};

const agentScope: RuntimeScope = {
  kind: 'agent',
  endpoint: connectorEndpoint,
  agentId: 'default',
};

const hermesSessionScope: RuntimeScope = {
  kind: 'session',
  identity: {
    ...sessionIdentity,
    endpoint: hermesEndpoint,
  },
};

const sessionTarget: CapabilityTarget = {
  kind: 'session',
  identity: sessionIdentity,
};

const approvalTarget: CapabilityTarget = {
  kind: 'approval',
  identity: sessionIdentity,
  approvalId: 'approval-1',
};

const modelSelectionTarget: CapabilityTarget = {
  kind: 'model-selection',
  identity: sessionIdentity,
  runtimeModelRef: 'anthropic/claude-opus-4-6',
};

const toolTarget: CapabilityTarget = {
  kind: 'tool',
  toolName: 'TaskList',
  identity: sessionIdentity,
};

function operationsForCapability(capabilityId: string): CapabilityOperationDescriptor[] {
  if (capabilityId === 'session.approval') {
    return [
      { id: 'approvals.list', title: 'List approvals', targetKind: 'session' },
      { id: 'approvals.resolve', title: 'Resolve approval', targetKind: 'approval' },
    ];
  }
  if (capabilityId === 'session.modelSelection') {
    return [
      { id: 'sessions.patchModel', title: 'Patch session model', targetKind: 'model-selection' },
    ];
  }
  if (capabilityId === 'tool.invoke') {
    return [
      { id: 'tools.invoke', title: 'Invoke tool', targetKind: 'tool' },
    ];
  }
  return [
    { id: 'sessions.create', title: 'Create session', targetKind: 'agent' },
    { id: 'sessions.load', title: 'Load session', targetKind: 'session' },
    { id: 'sessions.prompt', title: 'Prompt session', targetKind: 'session' },
    { id: 'sessions.abort', title: 'Abort session', targetKind: 'session' },
  ];
}

function descriptor(capabilityId: string, scope: RuntimeScope): CapabilityDescriptor {
  const operations = operationsForCapability(capabilityId);
  return {
    id: capabilityId,
    kind: 'session',
    scopeKind: scope.kind,
    scope,
    targetKinds: Array.from(new Set(operations.map((operation) => operation.targetKind))),
    protocolId: connectorEndpoint.protocolId,
    connectorId: connectorEndpoint.connectorId,
    endpointId: connectorEndpoint.endpointId,
    targetAgentIds: ['default'],
    supportLevel: 'native',
    availability: 'available',
    operations,
    policyScope: capabilityId,
    ownerModuleId: 'acp',
    routeOwnerId: 'sessions',
  };
}

describe('CapabilityRouter', () => {
  it('rejects duplicate operation routes for the same capability operation', () => {
    const handle = vi.fn(async () => ({ status: 200, data: {} }));

    expect(() => new CapabilityRouter({
      getCapability: () => descriptor('session.prompt', sessionScope),
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

  it('executes declared session.prompt operation with scope and target in payload', async () => {
    const capability = descriptor('session.prompt', sessionScope);
    const handle = vi.fn(async (payload: unknown) => ({ status: 200, data: { payload } }));
    const router = new CapabilityRouter({
      getCapability: (input) => {
        expect(input).toEqual({ id: 'session.prompt', scope: sessionScope });
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
      scope: sessionScope,
      target: sessionTarget,
      input: {
        sessionKey: sessionIdentity.sessionKey,
        message: 'hello',
      },
    });

    expect(response).toEqual({
      status: 200,
      data: {
        payload: {
          capabilityId: 'session.prompt',
          operationId: 'sessions.prompt',
          scope: sessionScope,
          target: sessionTarget,
          input: {
            sessionKey: sessionIdentity.sessionKey,
            message: 'hello',
          },
          domainInput: {
            sessionKey: sessionIdentity.sessionKey,
            message: 'hello',
          },
        },
      },
    });
    expect(handle).toHaveBeenCalledTimes(1);
  });

  it('executes declared session.approval operation with approval target in payload', async () => {
    const handle = vi.fn(async (payload: unknown) => ({ status: 200, data: { payload } }));
    const router = new CapabilityRouter({
      getCapability: (input) => {
        expect(input).toEqual({ id: 'session.approval', scope: sessionScope });
        return descriptor('session.approval', sessionScope);
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
      scope: sessionScope,
      target: approvalTarget,
      input: {
        id: 'approval-1',
        decision: 'allow-once',
      },
    })).resolves.toEqual({
      status: 200,
      data: {
        payload: {
          capabilityId: 'session.approval',
          operationId: 'approvals.resolve',
          scope: sessionScope,
          target: approvalTarget,
          input: {
            id: 'approval-1',
            decision: 'allow-once',
          },
          domainInput: {
            id: 'approval-1',
            decision: 'allow-once',
          },
        },
      },
    });
  });

  it('executes declared session.approval list operation with session target', async () => {
    const handle = vi.fn(async (payload: unknown) => ({ status: 200, data: { payload } }));
    const router = new CapabilityRouter({
      getCapability: () => descriptor('session.approval', sessionScope),
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
      scope: sessionScope,
      target: sessionTarget,
      input: {},
    })).resolves.toEqual({
      status: 200,
      data: {
        payload: {
          capabilityId: 'session.approval',
          operationId: 'approvals.list',
          scope: sessionScope,
          target: sessionTarget,
          input: {},
          domainInput: {},
        },
      },
    });
  });

  it('executes declared session model-selection operation with model target', async () => {
    const handle = vi.fn(async (payload: unknown) => ({ status: 200, data: { payload } }));
    const router = new CapabilityRouter({
      getCapability: (input) => {
        expect(input).toEqual({ id: 'session.modelSelection', scope: sessionScope });
        return descriptor('session.modelSelection', sessionScope);
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
      scope: sessionScope,
      target: modelSelectionTarget,
      input: {
        runtimeModelRef: 'anthropic/claude-opus-4-6',
      },
    })).resolves.toEqual({
      status: 200,
      data: {
        payload: {
          capabilityId: 'session.modelSelection',
          operationId: 'sessions.patchModel',
          scope: sessionScope,
          target: modelSelectionTarget,
          input: {
            runtimeModelRef: 'anthropic/claude-opus-4-6',
          },
          domainInput: {
            runtimeModelRef: 'anthropic/claude-opus-4-6',
          },
        },
      },
    });
  });

  it('executes declared tool.invoke operation with tool target', async () => {
    const handle = vi.fn(async (payload: unknown) => ({ status: 200, data: { payload } }));
    const router = new CapabilityRouter({
      getCapability: (input) => {
        expect(input).toEqual({ id: 'tool.invoke', scope: sessionScope });
        return descriptor('tool.invoke', sessionScope);
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
      scope: sessionScope,
      target: toolTarget,
      input: {
        method: 'TaskList',
        params: { sessionKey: sessionIdentity.sessionKey },
      },
    })).resolves.toEqual({
      status: 200,
      data: {
        payload: {
          capabilityId: 'tool.invoke',
          operationId: 'tools.invoke',
          scope: sessionScope,
          target: toolTarget,
          input: {
            method: 'TaskList',
            params: { sessionKey: sessionIdentity.sessionKey },
          },
          domainInput: {
            method: 'TaskList',
            params: { sessionKey: sessionIdentity.sessionKey },
          },
        },
      },
    });
  });

  it('rejects an execute request whose scope is malformed before registry lookup', async () => {
    const getCapability = vi.fn(() => descriptor('session.prompt', sessionScope));
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
      scope: {
        kind: 'session',
        identity: {
          endpoint: connectorEndpoint,
          sessionKey: sessionIdentity.sessionKey,
        },
      } as RuntimeScope,
      target: sessionTarget,
      input: {},
    })).resolves.toEqual({
      status: 400,
      data: { success: false, error: 'agentId is required' },
    });
    expect(getCapability).not.toHaveBeenCalled();
    expect(handle).not.toHaveBeenCalled();
  });

  it('rejects capability execution input with runtimeAddress', async () => {
    const handle = vi.fn(async () => ({ status: 200, data: {} }));
    const router = new CapabilityRouter({
      getCapability: () => descriptor('session.prompt', sessionScope),
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
      scope: sessionScope,
      target: sessionTarget,
      input: {
        runtimeAddress: {},
      },
    })).resolves.toEqual({
      status: 400,
      data: { success: false, error: 'Capability input runtimeAddress is not allowed' },
    });
    expect(handle).not.toHaveBeenCalled();
  });

  it('rejects a descriptor scope that differs from the execute request scope', async () => {
    const handle = vi.fn(async () => ({ status: 200, data: {} }));
    const router = new CapabilityRouter({
      getCapability: () => descriptor('session.prompt', hermesSessionScope),
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
      scope: sessionScope,
      target: sessionTarget,
      input: {},
    })).resolves.toEqual({
      status: 400,
      data: { success: false, error: 'Capability descriptor scope does not match request scope' },
    });
    expect(handle).not.toHaveBeenCalled();
  });

  it('rejects operations not declared by the descriptor', async () => {
    const router = new CapabilityRouter({
      getCapability: () => ({
        ...descriptor('session.prompt', sessionScope),
        operations: [{ id: 'sessions.prompt', title: 'Prompt session', targetKind: 'session' }],
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
      scope: sessionScope,
      target: sessionTarget,
      input: {},
    })).resolves.toEqual({
      status: 400,
      data: { success: false, error: 'Capability operation not supported: tools.invoke' },
    });
  });

  it('rejects missing targets for operations that require a target kind', async () => {
    const handle = vi.fn(async () => ({ status: 200, data: {} }));
    const router = new CapabilityRouter({
      getCapability: () => descriptor('session.prompt', sessionScope),
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
      scope: sessionScope,
      input: {},
    })).resolves.toEqual({
      status: 400,
      data: { success: false, error: 'Capability operation target is required: sessions.prompt' },
    });
    expect(handle).not.toHaveBeenCalled();
  });

  it('rejects target kind mismatches', async () => {
    const handle = vi.fn(async () => ({ status: 200, data: {} }));
    const router = new CapabilityRouter({
      getCapability: () => descriptor('session.prompt', sessionScope),
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
      scope: sessionScope,
      target: { kind: 'agent', agentId: 'default' },
      input: {},
    })).resolves.toEqual({
      status: 400,
      data: { success: false, error: 'Capability operation target kind must be session' },
    });
    expect(handle).not.toHaveBeenCalled();
  });

  it('rejects targets outside the request scope', async () => {
    const handle = vi.fn(async () => ({ status: 200, data: {} }));
    const router = new CapabilityRouter({
      getCapability: () => descriptor('session.prompt', sessionScope),
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
      scope: sessionScope,
      target: {
        kind: 'session',
        identity: {
          ...sessionIdentity,
          endpoint: hermesEndpoint,
        },
      },
      input: {},
    })).resolves.toEqual({
      status: 400,
      data: { success: false, error: 'Capability target does not belong to request scope' },
    });
    expect(handle).not.toHaveBeenCalled();
  });

  it('allows agent target operations in an agent scope', async () => {
    const handle = vi.fn(async (payload: unknown) => ({ status: 200, data: { payload } }));
    const router = new CapabilityRouter({
      getCapability: () => descriptor('session.prompt', agentScope),
      operations: [
        {
          capabilityId: 'session.prompt',
          operationId: 'sessions.create',
          handle,
        },
      ],
    });

    await expect(router.execute({
      id: 'session.prompt',
      operationId: 'sessions.create',
      scope: agentScope,
      target: { kind: 'agent', agentId: 'default' },
      input: { message: 'hello' },
    })).resolves.toEqual({
      status: 200,
      data: {
        payload: {
          capabilityId: 'session.prompt',
          operationId: 'sessions.create',
          scope: agentScope,
          target: { kind: 'agent', agentId: 'default' },
          input: { message: 'hello' },
          domainInput: { message: 'hello' },
        },
      },
    });
  });

  it('caches function-provided operation routes after the first execute', async () => {
    const handle = vi.fn(async () => ({ status: 200, data: { ok: true } }));
    const operations = vi.fn(() => [{
      capabilityId: 'session.prompt',
      operationId: 'sessions.prompt',
      handle,
    }]);
    const router = new CapabilityRouter({
      getCapability: () => descriptor('session.prompt', sessionScope),
      operations,
    });

    await router.execute({
      id: 'session.prompt',
      operationId: 'sessions.prompt',
      scope: sessionScope,
      target: sessionTarget,
      input: {},
    });
    await router.execute({
      id: 'session.prompt',
      operationId: 'sessions.prompt',
      scope: sessionScope,
      target: sessionTarget,
      input: {},
    });

    expect(operations).toHaveBeenCalledTimes(1);
    expect(handle).toHaveBeenCalledTimes(2);
  });

  it('indexes descriptor operations per descriptor instance', async () => {
    const operationIterator = vi.fn(function* () {
      yield { id: 'sessions.prompt', title: 'Prompt session', targetKind: 'session' };
    });
    const capability = {
      ...descriptor('session.prompt', sessionScope),
      operations: {
        [Symbol.iterator]: operationIterator,
        map: (mapper: (operation: { id: string; title: string; targetKind: 'session' }) => string) => Array.from(operationIterator(), mapper),
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
      scope: sessionScope,
      target: sessionTarget,
      input: {},
    });
    await router.execute({
      id: 'session.prompt',
      operationId: 'sessions.prompt',
      scope: sessionScope,
      target: sessionTarget,
      input: {},
    });

    expect(operationIterator).toHaveBeenCalledTimes(1);
  });

  it('rejects declared operations without a registered executor', async () => {
    const router = new CapabilityRouter({
      getCapability: () => descriptor('session.prompt', sessionScope),
      operations: [],
    });

    await expect(router.execute({
      id: 'session.prompt',
      operationId: 'sessions.prompt',
      scope: sessionScope,
      target: sessionTarget,
      input: {},
    })).resolves.toEqual({
      status: 400,
      data: { success: false, error: 'Capability execution not supported: session.prompt' },
    });
  });
});
