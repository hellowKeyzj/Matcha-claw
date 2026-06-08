import type { CapabilityOperationDescriptor } from '../contracts/capability-descriptor';
import type { CapabilityOperationContext, CapabilityOperationRoute } from '../contracts/capability-router';
import type { SessionCommandService } from '../../sessions/session-command-service';
import {
  sessionIdentitiesEqual,
  type SessionIdentity,
} from '../../agent-runtime/contracts/runtime-address';

export const SESSION_MANAGEMENT_CAPABILITY_ID = 'session.management';

export const sessionManagementCapabilityOperations: readonly CapabilityOperationDescriptor[] = [
  { id: 'sessions.list', title: 'List sessions', targetKind: 'runtime-endpoint' },
  { id: 'sessions.window', title: 'Get session window', targetKind: 'session' },
  { id: 'sessions.delete', title: 'Delete session', targetKind: 'session' },
  { id: 'sessions.rename', title: 'Rename session', targetKind: 'session' },
  { id: 'sessions.archive', title: 'Archive session', targetKind: 'session' },
  { id: 'sessions.unarchive', title: 'Unarchive session', targetKind: 'session' },
  { id: 'sessions.updateStatus', title: 'Update session status', targetKind: 'session' },
  { id: 'sessions.switch', title: 'Switch session', targetKind: 'session' },
  { id: 'sessions.resume', title: 'Resume session', targetKind: 'session' },
  { id: 'sessions.state', title: 'Get session state', targetKind: 'session' },
] as const;

function badRequest(message: string) {
  return { status: 400, data: { success: false, error: message } } as const;
}

function readInputRecord(input: unknown): Record<string, unknown> {
  return input && typeof input === 'object' && !Array.isArray(input) ? input as Record<string, unknown> : {};
}

function withSessionTargetValidation(
  handler: (context: CapabilityOperationContext) => ReturnType<CapabilityOperationRoute['handle']>,
): CapabilityOperationRoute['handle'] {
  return (context) => {
    if (context.target?.kind !== 'session') {
      return badRequest('Session target is required');
    }
    const input = readInputRecord(context.input);
    const sessionKey = typeof input.sessionKey === 'string' ? input.sessionKey.trim() : '';
    if (sessionKey && sessionKey !== context.target.identity.sessionKey) {
      return badRequest('sessionKey must match target SessionIdentity.sessionKey');
    }
    const inputIdentity = input.sessionIdentity as SessionIdentity | undefined;
    if (inputIdentity && !sessionIdentitiesEqual(inputIdentity, context.target.identity)) {
      return badRequest('SessionIdentity must match capability target identity');
    }
    return handler({
      ...context,
      input: {
        ...input,
        sessionKey: context.target.identity.sessionKey,
        sessionIdentity: context.target.identity,
      },
    });
  };
}

export function createSessionManagementCapabilityOperationRoutes(deps: {
  commandService: SessionCommandService;
}): readonly CapabilityOperationRoute[] {
  return [
    {
      capabilityId: SESSION_MANAGEMENT_CAPABILITY_ID,
      operationId: 'sessions.list',
      handle: (context) => deps.commandService.listSessions(context.input),
    },
    {
      capabilityId: SESSION_MANAGEMENT_CAPABILITY_ID,
      operationId: 'sessions.window',
      handle: withSessionTargetValidation((context) => deps.commandService.getSessionWindow(context.input)),
    },
    {
      capabilityId: SESSION_MANAGEMENT_CAPABILITY_ID,
      operationId: 'sessions.delete',
      handle: withSessionTargetValidation((context) => deps.commandService.deleteSession(context.input)),
    },
    {
      capabilityId: SESSION_MANAGEMENT_CAPABILITY_ID,
      operationId: 'sessions.rename',
      handle: withSessionTargetValidation((context) => deps.commandService.renameSession(context.input)),
    },
    {
      capabilityId: SESSION_MANAGEMENT_CAPABILITY_ID,
      operationId: 'sessions.archive',
      handle: withSessionTargetValidation((context) => deps.commandService.archiveSession(context.input)),
    },
    {
      capabilityId: SESSION_MANAGEMENT_CAPABILITY_ID,
      operationId: 'sessions.unarchive',
      handle: withSessionTargetValidation((context) => deps.commandService.unarchiveSession(context.input)),
    },
    {
      capabilityId: SESSION_MANAGEMENT_CAPABILITY_ID,
      operationId: 'sessions.updateStatus',
      handle: withSessionTargetValidation((context) => deps.commandService.updateSessionStatus(context.input)),
    },
    {
      capabilityId: SESSION_MANAGEMENT_CAPABILITY_ID,
      operationId: 'sessions.switch',
      handle: withSessionTargetValidation((context) => deps.commandService.switchSession(context.input)),
    },
    {
      capabilityId: SESSION_MANAGEMENT_CAPABILITY_ID,
      operationId: 'sessions.resume',
      handle: withSessionTargetValidation((context) => deps.commandService.resumeSession(context.input)),
    },
    {
      capabilityId: SESSION_MANAGEMENT_CAPABILITY_ID,
      operationId: 'sessions.state',
      handle: withSessionTargetValidation((context) => deps.commandService.getSessionStateSnapshot(context.input)),
    },
  ];
}
