import type { ApplicationResponseOf } from '../common/application-response';
import type { RemoteFleetOperationId } from './remote-fleet-operation-id';

export interface RemoteFleetPort {
  invoke(operationId: RemoteFleetOperationId, params: unknown): Promise<ApplicationResponseOf>;
  close?(): Promise<void>;
}
