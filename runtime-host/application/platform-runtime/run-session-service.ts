import type {
  AgentRuntimeDriver,
  AssembleRequest,
  AuditSinkPort,
  ContextAssemblerPort,
  EventBusPort,
  RunId,
} from '../../shared/platform-runtime-contracts';
import type { RuntimeClockPort } from '../common/runtime-ports';

export class RunSessionService {
  constructor(
    private readonly contextAssembler: ContextAssemblerPort,
    private readonly runtimeDriver: AgentRuntimeDriver,
    private readonly eventBus: EventBusPort,
    private readonly auditSink: AuditSinkPort,
    private readonly clock: RuntimeClockPort,
  ) {}

  async start(req: AssembleRequest, eventTx?: unknown): Promise<RunId> {
    const context = await this.contextAssembler.assemble(req);
    const runId = await this.runtimeDriver.execute(context, eventTx);
    await this.eventBus.publish({
      type: 'run.started',
      ts: this.clock.nowMs(),
      runId,
      sessionId: context.sessionId,
      payload: { enabledToolCount: context.enabledTools.length },
    });
    await this.auditSink.append({
      type: 'run.started',
      ts: this.clock.nowMs(),
      payload: { runId, sessionId: context.sessionId },
    });
    return runId;
  }

  async abort(runId: RunId): Promise<void> {
    await this.runtimeDriver.abort(runId);
    await this.eventBus.publish({
      type: 'run.aborted',
      ts: this.clock.nowMs(),
      runId,
    });
    await this.auditSink.append({
      type: 'run.aborted',
      ts: this.clock.nowMs(),
      payload: { runId },
    });
  }
}
