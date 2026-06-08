import type { CapabilityOperationDescriptor } from '../contracts/capability-descriptor';
import type { CapabilityOperationRoute } from '../contracts/capability-router';
import type { SessionCommandService } from '../../sessions/session-command-service';

export const SESSION_MODEL_SELECTION_CAPABILITY_ID = 'session.modelSelection';

export const sessionModelSelectionCapabilityOperations: readonly CapabilityOperationDescriptor[] = [
  { id: 'sessions.patchModel', title: 'Patch session model', targetKind: 'model-selection' },
] as const;

export function createSessionModelSelectionCapabilityOperationRoutes(deps: {
  commandService: SessionCommandService;
}): readonly CapabilityOperationRoute[] {
  return [
    {
      capabilityId: SESSION_MODEL_SELECTION_CAPABILITY_ID,
      operationId: 'sessions.patchModel',
      handle: (context) => deps.commandService.patchSession(context.input),
    },
  ];
}
