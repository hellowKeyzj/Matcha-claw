import type {
  SessionPromptResult,
} from '../../shared/session-adapter-types';
import type {
  RuntimeIdGeneratorPort,
} from '../common/runtime-ports';
import {
  readPromptSessionRequest,
} from './session-runtime-requests';
import {
  badRequest,
  ok,
  type ApplicationResponseOf,
} from '../common/application-response';
import type { SessionRunWorkflow } from '../workflows/session-run/session-run-workflow';

export interface SessionPromptServiceDeps {
  idGenerator: RuntimeIdGeneratorPort;
  sessionRunWorkflow: SessionRunWorkflow;
}

export class SessionPromptService {
  constructor(private readonly deps: SessionPromptServiceDeps) {}

  async promptSession(payload: unknown): Promise<ApplicationResponseOf<SessionPromptResult | { success: false; error: string }>> {
    const {
      directBody,
      mediaBody,
      sessionKey,
      message,
      requestedRunId,
      sessionIdentity,
      sessionIdentityError,
    } = readPromptSessionRequest(payload);
    const sessionId = sessionKey;
    if (!sessionId) {
      return badRequest('sessionKey is required');
    }
    if (sessionIdentityError || !sessionIdentity) {
      return badRequest(sessionIdentityError ?? 'SessionIdentity is required');
    }
    if (!message.trim() && !(Array.isArray(mediaBody?.media) && mediaBody.media.length > 0)) {
      return badRequest('message is required');
    }

    return ok(await this.deps.sessionRunWorkflow.execute({
      directBody,
      mediaBody,
      sessionId,
      message,
      runId: requestedRunId || this.deps.idGenerator.randomId(),
      sessionIdentity,
    }));
  }
}
