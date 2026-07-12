import { describe, expect, it } from 'vitest';
import {
  REMOTE_FLEET_BOOTSTRAP_COMMAND_ENVELOPE_VERSION,
  REMOTE_FLEET_COMMAND_DISPATCH_ENVELOPE_VERSION,
  REMOTE_FLEET_SECRET_HOST_RPC_METHOD,
  REMOTE_FLEET_SECRET_HOST_RPC_RESULT_TYPE,
  REMOTE_FLEET_SECRET_RESOLVE_PURPOSE,
  WorkerBackedRemoteFleetService,
  buildK8sApiUrl,
  buildRemoteFleetCommandDispatchEnvelope,
  buildRemoteFleetOpsTimeline,
  createRemoteFleetTerminalK8sProvider,
  dispatchRemoteFleetHostRequest,
  findUnsafeRemoteFleetEndpointUrlKey,
  normalizeRuntimeAgentIngressOperation,
  validateSecretResolveRequest,
} from '../../runtime-host/application/remote-fleet';
import type {
  BuildRemoteFleetCommandDispatchEnvelopeResult,
  RemoteFleetBootstrapCommandEnvelope,
  RemoteFleetBootstrapCommandResult,
  RemoteFleetBootstrapDispatcherPort,
  RemoteFleetCommandDispatchEnvelope,
  RemoteFleetCommandDispatchIssue,
  RemoteFleetDispatchCommandName,
  RemoteFleetHostRequestDispatchDeps,
  RemoteFleetOpsTimeline,
  RemoteFleetOpsTimelineEntry,
  RemoteFleetRuntimeAgentDispatchResult,
  RemoteFleetRuntimeAgentDispatcherPort,
  RemoteFleetSecretResolveHostRpcResult,
  RemoteFleetSecretResolveRequestInput,
  RuntimeAgentIngressInvalidReason,
  RuntimeAgentIngressResult,
  RuntimeAgentProbeNodeCommandPayload,
  RuntimeAgentProbeNodeTargetPayload,
} from '../../runtime-host/application/remote-fleet';

const typeSurface = {
  dispatchName: 'start-runtime' as RemoteFleetDispatchCommandName,
  ingressInvalidReason: 'unsupported-operation' as RuntimeAgentIngressInvalidReason,
  hostRequestDeps: {} as RemoteFleetHostRequestDispatchDeps,
  runtimeAgentDispatcher: null as unknown as RemoteFleetRuntimeAgentDispatcherPort,
  runtimeAgentDispatchResult: null as unknown as RemoteFleetRuntimeAgentDispatchResult,
  bootstrapDispatcher: null as unknown as RemoteFleetBootstrapDispatcherPort,
  bootstrapCommandResult: null as unknown as RemoteFleetBootstrapCommandResult,
  bootstrapEnvelope: null as unknown as RemoteFleetBootstrapCommandEnvelope,
  secretInput: null as unknown as RemoteFleetSecretResolveRequestInput,
  secretResult: null as unknown as RemoteFleetSecretResolveHostRpcResult,
  dispatchIssue: null as unknown as RemoteFleetCommandDispatchIssue,
  dispatchEnvelope: null as unknown as RemoteFleetCommandDispatchEnvelope,
  opsTimeline: null as unknown as RemoteFleetOpsTimeline,
  opsTimelineEntry: null as unknown as RemoteFleetOpsTimelineEntry,
  probeNodePayload: null as unknown as RuntimeAgentProbeNodeCommandPayload,
  probeNodeTarget: null as unknown as RuntimeAgentProbeNodeTargetPayload,
  ingressResult: null as unknown as RuntimeAgentIngressResult,
  dispatchResult: null as unknown as BuildRemoteFleetCommandDispatchEnvelopeResult,
};

describe('Remote Fleet barrel export surface', () => {
  it('exposes command dispatch, ingress, host request, and secret public seams', () => {
    expect(REMOTE_FLEET_BOOTSTRAP_COMMAND_ENVELOPE_VERSION).toBe('remote-fleet-bootstrap-command/v1');
    expect(REMOTE_FLEET_COMMAND_DISPATCH_ENVELOPE_VERSION).toBe('remote-fleet-command-dispatch/v1');
    expect(REMOTE_FLEET_SECRET_HOST_RPC_METHOD).toBe('host.secret.resolve');
    expect(REMOTE_FLEET_SECRET_HOST_RPC_RESULT_TYPE).toBe('host.secret.resolve.result');
    expect(REMOTE_FLEET_SECRET_RESOLVE_PURPOSE).toBe('worker-command-execution');
    expect(typeof WorkerBackedRemoteFleetService).toBe('function');
    expect(typeof buildK8sApiUrl).toBe('function');
    expect(typeof createRemoteFleetTerminalK8sProvider).toBe('function');
    expect(typeof buildRemoteFleetCommandDispatchEnvelope).toBe('function');
    expect(typeof buildRemoteFleetOpsTimeline).toBe('function');
    expect(typeof dispatchRemoteFleetHostRequest).toBe('function');
    expect(typeof findUnsafeRemoteFleetEndpointUrlKey).toBe('function');
    expect(typeof normalizeRuntimeAgentIngressOperation).toBe('function');
    expect(typeof validateSecretResolveRequest).toBe('function');
  });

  it('keeps type-only public seams importable from the barrel', () => {
    expect(typeSurface.dispatchName).toBe('start-runtime');
    expect(typeSurface.ingressInvalidReason).toBe('unsupported-operation');
    expect(typeSurface.hostRequestDeps).toEqual({});
    expect('runtimeAgentDispatcher' in typeSurface).toBe(true);
    expect('runtimeAgentDispatchResult' in typeSurface).toBe(true);
    expect('bootstrapDispatcher' in typeSurface).toBe(true);
    expect('bootstrapCommandResult' in typeSurface).toBe(true);
    expect('bootstrapEnvelope' in typeSurface).toBe(true);
    expect('secretInput' in typeSurface).toBe(true);
    expect('secretResult' in typeSurface).toBe(true);
    expect('dispatchIssue' in typeSurface).toBe(true);
    expect('dispatchEnvelope' in typeSurface).toBe(true);
    expect('opsTimeline' in typeSurface).toBe(true);
    expect('opsTimelineEntry' in typeSurface).toBe(true);
    expect('probeNodePayload' in typeSurface).toBe(true);
    expect('probeNodeTarget' in typeSurface).toBe(true);
    expect('ingressResult' in typeSurface).toBe(true);
    expect('dispatchResult' in typeSurface).toBe(true);
  });
});
