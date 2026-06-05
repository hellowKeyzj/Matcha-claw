import type { CapabilityOperationDescriptor } from '../contracts/capability-descriptor';
import type { CapabilityOperationRoute } from '../contracts/capability-router';
import type { SessionCommandService } from '../../sessions/session-command-service';

export const SESSION_MANAGEMENT_CAPABILITY_ID = 'session.management';

export const sessionManagementCapabilityOperations: readonly CapabilityOperationDescriptor[] = [
  { id: 'sessions.list', title: 'List sessions' },
  { id: 'sessions.window', title: 'Get session window' },
  { id: 'sessions.delete', title: 'Delete session' },
  { id: 'sessions.rename', title: 'Rename session' },
  { id: 'sessions.archive', title: 'Archive session' },
  { id: 'sessions.unarchive', title: 'Unarchive session' },
  { id: 'sessions.updateStatus', title: 'Update session status' },
  { id: 'sessions.switch', title: 'Switch session' },
  { id: 'sessions.resume', title: 'Resume session' },
  { id: 'sessions.state', title: 'Get session state' },
] as const;

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
      handle: (context) => deps.commandService.getSessionWindow(context.input),
    },
    {
      capabilityId: SESSION_MANAGEMENT_CAPABILITY_ID,
      operationId: 'sessions.delete',
      handle: (context) => deps.commandService.deleteSession(context.input),
    },
    {
      capabilityId: SESSION_MANAGEMENT_CAPABILITY_ID,
      operationId: 'sessions.rename',
      handle: (context) => deps.commandService.renameSession(context.input),
    },
    {
      capabilityId: SESSION_MANAGEMENT_CAPABILITY_ID,
      operationId: 'sessions.archive',
      handle: (context) => deps.commandService.archiveSession(context.input),
    },
    {
      capabilityId: SESSION_MANAGEMENT_CAPABILITY_ID,
      operationId: 'sessions.unarchive',
      handle: (context) => deps.commandService.unarchiveSession(context.input),
    },
    {
      capabilityId: SESSION_MANAGEMENT_CAPABILITY_ID,
      operationId: 'sessions.updateStatus',
      handle: (context) => deps.commandService.updateSessionStatus(context.input),
    },
    {
      capabilityId: SESSION_MANAGEMENT_CAPABILITY_ID,
      operationId: 'sessions.switch',
      handle: (context) => deps.commandService.switchSession(context.input),
    },
    {
      capabilityId: SESSION_MANAGEMENT_CAPABILITY_ID,
      operationId: 'sessions.resume',
      handle: (context) => deps.commandService.resumeSession(context.input),
    },
    {
      capabilityId: SESSION_MANAGEMENT_CAPABILITY_ID,
      operationId: 'sessions.state',
      handle: (context) => deps.commandService.getSessionStateSnapshot(context.input),
    },
  ];
}
