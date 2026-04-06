import type {
  AgentRuntimeDriver,
  AssembleRequest,
  AuditSinkPort,
  ContextAssemblerPort,
  EventBusPort,
  RunId,
} from '../../shared/platform-runtime-contracts';

export class RunSessionService {
  constructor(
    private readonly contextAssembler: ContextAssemblerPort,
    private readonly runtimeDriver: AgentRuntimeDriver,
    private readonly eventBus: EventBusPort,
    private readonly auditSink: AuditSinkPort,
  ) {}

  async start(req: AssembleRequest, eventTx?: unknown): Promise<RunId> {
    const context = await this.contextAssembler.assemble(req);
    const runId = await this.runtimeDriver.execute(context, eventTx);
    await this.eventBus.publish({
      type: 'run.started',
      ts: Date.now(),
      runId,
      sessionId: context.sessionId,
      payload: { enabledToolCount: context.enabledTools.length },
    });
    await this.auditSink.append({
      type: 'run.started',
      ts: Date.now(),
      payload: { runId, sessionId: context.sessionId },
    });
    return runId;
  }

  async abort(runId: RunId): Promise<void> {
    await this.runtimeDriver.abort(runId);
    await this.eventBus.publish({
      type: 'run.aborted',
      ts: Date.now(),
      runId,
    });
    await this.auditSink.append({
      type: 'run.aborted',
      ts: Date.now(),
      payload: { runId },
    });
  }
}
