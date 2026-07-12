import type { RuntimeScope } from '../agent-runtime/contracts/runtime-address';
import type { CapabilityDescriptor } from '../capabilities/contracts/capability-descriptor';
import type { ApplicationResponseOf } from '../common/application-response';
import type { RemoteFleetOperationId } from './remote-fleet-operation-id';
import type { RemoteFleetWorkerConfig } from './remote-fleet-model';
import type {
  RemoteFleetBootstrapCommandEnvelope,
  RemoteFleetConnectionProbeEnvelope,
} from './remote-fleet-bootstrap';
import type { RemoteFleetCommandDispatchEnvelope } from './remote-fleet-command-dispatch';
import type {
  RemoteFleetSecretWriteHostRpcRequest,
  RemoteFleetSecretWriteStatusHostRpcRequest,
} from './remote-fleet-credential-host-rpc';
import type { RemoteFleetSecretResolveHostRpcRequest } from './remote-fleet-secret-host-rpc';
import type {
  RemoteFleetTerminalCloseSessionHostRpcRequest,
  RemoteFleetTerminalIssueTicketHostRpcRequest,
} from './remote-fleet-terminal-contracts';

export const REMOTE_FLEET_WORKER_FAILURE_MESSAGE = 'Remote Fleet worker request failed.';

export interface RemoteFleetWorkerError {
  readonly message: typeof REMOTE_FLEET_WORKER_FAILURE_MESSAGE;
}

export function serializeRemoteFleetWorkerError(_error: unknown): RemoteFleetWorkerError {
  return { message: REMOTE_FLEET_WORKER_FAILURE_MESSAGE };
}

export function errorFromRemoteFleetWorker(_error: RemoteFleetWorkerError): Error {
  return new Error(REMOTE_FLEET_WORKER_FAILURE_MESSAGE);
}

export type RemoteFleetWorkerRequest = {
  readonly type: 'remote-fleet.invoke';
  readonly requestId: string;
  readonly operationId: RemoteFleetOperationId;
  readonly params: unknown;
};

export type RemoteFleetWorkerCloseRequest = {
  readonly type: 'remote-fleet.close';
  readonly requestId: string;
};

export type RemoteFleetWorkerResponse =
  | {
      readonly type: 'remote-fleet.result';
      readonly requestId: string;
      readonly ok: true;
      readonly response: ApplicationResponseOf;
    }
  | {
      readonly type: 'remote-fleet.result';
      readonly requestId: string;
      readonly ok: false;
      readonly error: RemoteFleetWorkerError;
    };

export type RemoteFleetHostRequest =
  | {
      readonly type: 'host.event.emit';
      readonly requestId: string;
      readonly eventName: string;
      readonly payload: unknown;
    }
  | {
      readonly type: 'host.capability.replaceForEndpointScope';
      readonly requestId: string;
      readonly scope: RuntimeScope;
      readonly descriptors: readonly CapabilityDescriptor[];
    }
  | {
      readonly type: 'host.capability.pruneEndpointScope';
      readonly requestId: string;
      readonly scope: RuntimeScope;
    }
  | {
      readonly type: 'host.runtimeAgent.dispatchCommand';
      readonly requestId: string;
      readonly envelope: RemoteFleetCommandDispatchEnvelope;
    }
  | {
      readonly type: 'host.remoteFleetBootstrap.dispatchCommand';
      readonly requestId: string;
      readonly envelope: RemoteFleetBootstrapCommandEnvelope;
    }
  | {
      readonly type: 'host.remoteFleetConnectionProbe.dispatch';
      readonly requestId: string;
      readonly envelope: RemoteFleetConnectionProbeEnvelope;
    }
  | RemoteFleetTerminalIssueTicketHostRpcRequest
  | RemoteFleetTerminalCloseSessionHostRpcRequest
  | RemoteFleetSecretResolveHostRpcRequest
  | RemoteFleetSecretWriteHostRpcRequest
  | RemoteFleetSecretWriteStatusHostRpcRequest;

export type RemoteFleetHostRequestWithoutId = RemoteFleetHostRequest extends infer Request
  ? Request extends { readonly requestId: string }
    ? Omit<Request, 'requestId'>
    : never
  : never;

export type RemoteFleetHostResponse =
  | {
      readonly type: 'host.result';
      readonly requestId: string;
      readonly ok: true;
      readonly result: unknown;
    }
  | {
      readonly type: 'host.result';
      readonly requestId: string;
      readonly ok: false;
      readonly error: RemoteFleetWorkerError;
    };

export type RemoteFleetMainToWorkerMessage = RemoteFleetWorkerRequest | RemoteFleetWorkerCloseRequest | RemoteFleetHostResponse;
export type RemoteFleetWorkerToMainMessage = RemoteFleetWorkerResponse | RemoteFleetHostRequest;

export type { RemoteFleetWorkerConfig };
