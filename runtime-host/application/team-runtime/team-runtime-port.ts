import type { ApplicationResponseOf } from '../common/application-response';
import type { RuntimeScope } from '../agent-runtime/contracts/runtime-address';
import type { TeamRuntimeOperationId } from './team-runtime-operation-id';

export interface TeamRuntimePort {
  invoke(operationId: TeamRuntimeOperationId, params: unknown, scope?: RuntimeScope): Promise<ApplicationResponseOf>;
  close?(): Promise<void>;
}
