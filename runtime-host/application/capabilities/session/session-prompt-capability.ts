import { normalizeSendWithMediaInput, sendWithMediaViaGateway } from '../../chat/send-media';
import { badRequest, ok, serverError } from '../../common/application-response';
import type { RuntimeFileSystemPort } from '../../common/runtime-ports';
import type { GatewayChatPort } from '../../gateway/gateway-runtime-port';
import type { CapabilityOperationDescriptor } from '../contracts/capability-descriptor';
import type { CapabilityOperationRoute } from '../contracts/capability-router';
import type { SessionCommandService } from '../../sessions/session-command-service';
import type { SessionPromptService } from '../../sessions/session-prompt-service';

export const SESSION_PROMPT_CAPABILITY_ID = 'session.prompt';

export const sessionPromptCapabilityOperations: readonly CapabilityOperationDescriptor[] = [
  { id: 'sessions.create', title: 'Create session' },
  { id: 'sessions.prompt', title: 'Prompt session' },
  { id: 'sessions.sendWithMedia', title: 'Send session prompt with media' },
  { id: 'sessions.abort', title: 'Abort session' },
  { id: 'sessions.load', title: 'Load session' },
] as const;

export function createSessionPromptCapabilityOperationRoutes(deps: {
  commandService: SessionCommandService;
  promptService: SessionPromptService;
  fileSystem?: RuntimeFileSystemPort;
  gateway?: GatewayChatPort;
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
      handle: (context) => deps.commandService.loadSession(context.input),
    },
    {
      capabilityId: SESSION_PROMPT_CAPABILITY_ID,
      operationId: 'sessions.prompt',
      handle: (context) => deps.promptService.promptSession(context.input),
    },
    {
      capabilityId: SESSION_PROMPT_CAPABILITY_ID,
      operationId: 'sessions.sendWithMedia',
      handle: async (context) => {
        if (!deps.fileSystem || !deps.gateway) {
          return badRequest('sessions.sendWithMedia is not supported by this runtime');
        }
        const input = normalizeSendWithMediaInput(context.input);
        if (!input) {
          return badRequest('Invalid send-with-media payload');
        }
        const result = await sendWithMediaViaGateway(deps.fileSystem, deps.gateway, input);
        if (!result.success) {
          return serverError(result.error ?? 'Send-with-media failed');
        }
        return ok({ success: true, result: result.result });
      },
    },
    {
      capabilityId: SESSION_PROMPT_CAPABILITY_ID,
      operationId: 'sessions.abort',
      handle: (context) => deps.commandService.abortSession(context.input),
    },
  ];
}
