import { describe, expect, it } from 'vitest';

import {
  buildFleetRegistrationPlan,
  completeFleetRegistrationReceipt,
  projectFleetRegistration,
  type FleetCanonicalReadFacts,
} from '../../electron/main/runtime-host-delivery/transport/fleet-registration';

const connectionFacts: FleetCanonicalReadFacts = {
  connections: [{
    id: 'connection-1',
    kind: 'sshHost',
    displayName: 'host',
    endpoint: 'ssh://host:22',
    labels: ['prod'],
    enabled: true,
  }],
  environments: [],
  nodes: [],
  agents: [],
  runtimes: [],
};

const environmentFacts: FleetCanonicalReadFacts = {
  ...connectionFacts,
  environments: [{
    id: 'environment-1',
    connectionId: 'connection-1',
    kind: 'sshWorkdir',
    displayName: 'workdir',
    labels: ['prod'],
    enabled: true,
  }],
  nodes: [{
    id: 'node-1',
    connectionId: 'connection-1',
    environmentId: 'environment-1',
    managedResourceId: null,
    health: 'unknown',
  }],
  agents: [{
    id: 'node-1:agent',
    nodeId: 'node-1',
    connectionId: 'connection-1',
    environmentId: 'environment-1',
    managedResourceId: null,
  }],
  runtimes: [{
    id: 'node-1:openclaw',
    nodeId: 'node-1',
    agentId: 'node-1:agent',
    connectionId: 'connection-1',
    environmentId: 'environment-1',
    managedResourceId: null,
    kind: 'openClaw',
    state: 'discovered',
  }],
};

describe('Fleet legacy registration contract', () => {
  it('maps a complete connection body to the canonical connection upsert without endpoint identity inference', () => {
    const plan = buildFleetRegistrationPlan('register-connection', {
      connection: {
        id: 'connection-1',
        displayName: 'host',
        connectionKind: 'ssh-host',
        targetKind: 'ssh-host',
        endpointUrl: 'ssh://host:22',
        labels: ['prod'],
        enabled: true,
        publicConfig: { host: 'host', port: '22' },
        secretRefs: { privateKey: { kind: 'secret-ref', ref: 'remote-fleet://ssh/key' } },
      },
    });

    expect(plan).toMatchObject({
      status: 'accepted',
      association: {
        connectionId: 'connection-1',
        environmentId: null,
        nodeId: null,
      },
      sequence: [{
        sequence: 1,
        request: {
          operation: 'fleet.connections.upsert',
          input: {
            kind: 'connectionUpsert',
            payload: {
              id: 'connection-1',
              kind: 'sshHost',
              endpoint: 'ssh://host:22',
              publicConfig: { host: 'host', port: '22' },
              secretRefs: { privateKey: 'remote-fleet://ssh/key' },
            },
          },
        },
      }],
    });
  });

  it('rejects missing ids, nested config, and unsupported descriptions instead of synthesizing canonical facts', () => {
    expect(buildFleetRegistrationPlan('register-connection', {
      connection: { displayName: 'host', connectionKind: 'ssh-host', enabled: true },
    })).toMatchObject({ status: 'rejected', rejection: { code: 'missing_canonical_id' } });
    expect(buildFleetRegistrationPlan('register-connection', {
      connection: {
        id: 'connection-1', displayName: 'host', connectionKind: 'ssh-host', enabled: true,
        publicConfig: { ssh: { host: 'host' } },
      },
    })).toMatchObject({ status: 'rejected', rejection: { code: 'unsupported_public_config' } });
    expect(buildFleetRegistrationPlan('register-connection', {
      connection: {
        id: 'connection-1', displayName: 'host', connectionKind: 'ssh-host', enabled: true,
        description: 'not in Rust canonical record',
      },
    })).toMatchObject({ status: 'rejected', rejection: { code: 'unsupported_description' } });
  });

  it('requires explicit environment node association and never invents node, agent, runtime, target, or revision', () => {
    expect(buildFleetRegistrationPlan('register-environment', {
      environment: {
        id: 'environment-1', connectionId: 'connection-1', environmentKind: 'ssh-workdir',
        displayName: 'workdir', enabled: true,
      },
    })).toMatchObject({ status: 'rejected', rejection: { code: 'unsupported_environment_association' } });

    const plan = buildFleetRegistrationPlan('register-environment', {
      environment: {
        id: 'environment-1', connectionId: 'connection-1', nodeId: 'node-1',
        environmentKind: 'ssh-workdir', targetKind: 'ssh-host', displayName: 'workdir',
        enabled: true, publicConfig: { root: '/workspace' }, secretRefs: {},
      },
    });
    expect(plan).toMatchObject({
      status: 'accepted',
      association: { connectionId: 'connection-1', environmentId: 'environment-1', nodeId: 'node-1' },
      sequence: [{ request: { operation: 'fleet.environments.register' } }],
    });
    expect(plan.sequence[0].request.input).not.toHaveProperty('payload.nodeId');
  });

  it('rejects the legacy node route because topology upsert is observation, not registration authority', () => {
    expect(buildFleetRegistrationPlan('register-node', {
      node: { id: 'node-1', connectionId: 'connection-1', targetKind: 'ssh-host' },
    })).toMatchObject({ status: 'rejected', rejection: { code: 'unsupported_node_registration' } });
  });

  it('projects only uniquely identified canonical facts and keeps the association source-bound', () => {
    const plan = buildFleetRegistrationPlan('register-environment', {
      environment: {
        id: 'environment-1', connectionId: 'connection-1', nodeId: 'node-1',
        environmentKind: 'ssh-workdir', displayName: 'workdir', enabled: true,
      },
    });
    const projection = projectFleetRegistration(plan, environmentFacts);
    expect(projection).toMatchObject({
      source: 'canonical-fleet-read',
      environment: { id: 'environment-1', connectionId: 'connection-1', targetKind: 'ssh-host' },
      node: { id: 'node-1', environmentId: 'environment-1' },
      agent: { id: 'node-1:agent', nodeId: 'node-1' },
      runtime: { id: 'node-1:openclaw', agentId: 'node-1:agent' },
    });
  });

  it('requires the exact mutation receipt and read projection contract', () => {
    const plan = buildFleetRegistrationPlan('register-connection', {
      connection: { id: 'connection-1', connectionKind: 'ssh-host', displayName: 'host', enabled: true },
    });
    expect(completeFleetRegistrationReceipt(plan, [{
      sequence: 1,
      operation: 'fleet.connections.upsert',
      outcome: 'environmentRegistered',
    }])).toMatchObject({ status: 'rejected', rejection: { code: 'canonical_outcome_rejected' } });

    const projection = projectFleetRegistration(plan, connectionFacts);
    expect(completeFleetRegistrationReceipt(plan, [{
      sequence: 1,
      operation: 'fleet.connections.upsert',
      outcome: 'connectionUpdated',
    }], projection as never)).toMatchObject({ status: 'accepted', sequence: [{ sequence: 1 }] });
  });
});
