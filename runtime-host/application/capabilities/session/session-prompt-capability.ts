import { badRequest } from '../../common/application-response';
import type { CapabilityOperationDescriptor } from '../contracts/capability-descriptor';
import type { CapabilityOperationContext, CapabilityOperationRoute } from '../contracts/capability-router';
import type { SessionCommandService } from '../../sessions/session-command-service';
import type { SessionPromptService } from '../../sessions/session-prompt-service';
import {
  sessionIdentitiesEqual,
  type SessionIdentity,
} from '../../agent-runtime/contracts/runtime-address';

export const SESSION_PROMPT_CAPABILITY_ID = 'session.prompt';

export const sessionPromptCapabilityOperations: readonly CapabilityOperationDescriptor[] = [
  { id: 'sessions.create', title: 'Create session', targetKind: 'agent' },
  { id: 'sessions.prompt', title: 'Prompt session', targetKind: 'session' },
  { id: 'sessions.sendWithMedia', title: 'Send session prompt with media', targetKind: 'session' },
  { id: 'sessions.abort', title: 'Abort session', targetKind: 'session' },
  { id: 'sessions.load', title: 'Load session', targetKind: 'session' },
] as const;

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

export function createSessionPromptCapabilityOperationRoutes(deps: {
  commandService: SessionCommandService;
  promptService: SessionPromptService;
}): readonly CapabilityOperationRoute[] {
  return [
    {
      capabilityId: SESSION_PROMPT_CAPABILITY_ID,
      operationId: 'sessions.create',
      handle: (context) => deps.commandService.createSession(context.input),
    },
    {
      capabilityId: SESSION_PROMPT_CAPABILITY_ID,
      operationId: 'sessions.load',
      handle: withSessionTargetValidation((context) => deps.commandService.loadSession(context.input)),
    },
    {
      capabilityId: SESSION_PROMPT_CAPABILITY_ID,
      operationId: 'sessions.prompt',
      handle: withSessionTargetValidation((context) => deps.promptService.promptSession(context.input)),
    },
    {
      capabilityId: SESSION_PROMPT_CAPABILITY_ID,
      operationId: 'sessions.sendWithMedia',
      handle: withSessionTargetValidation((context) => deps.promptService.promptSession(context.input)),
    },
    {
      capabilityId: SESSION_PROMPT_CAPABILITY_ID,
      operationId: 'sessions.abort',
      handle: withSessionTargetValidation((context) => deps.commandService.abortSession(context.input)),
    },
  ];
}
