import type {
  AssembleRequest,
  RunId,
} from '../../shared/platform-runtime-contracts';
import type { PlatformRunSessionWorkflow } from '../workflows/platform-runtime/platform-run-session-workflow';

export class RunSessionService {
  constructor(
    private readonly runSessionWorkflow: Pick<PlatformRunSessionWorkflow, 'start' | 'abort'>,
  ) {}

  async start(req: AssembleRequest, eventTx?: unknown): Promise<RunId> {
    return await this.runSessionWorkflow.start(req, eventTx);
  }

  async abort(runId: RunId): Promise<void> {
    await this.runSessionWorkflow.abort(runId);
  }
}
