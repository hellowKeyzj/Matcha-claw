import type {
  AgentRuntimeDriver,
  AssembleRequest,
  AuditSinkPort,
  ContextAssemblerPort,
  EventBusPort,
  RunId,
} from '../../../shared/platform-runtime-contracts';
import type { RuntimeClockPort } from '../../common/runtime-ports';

export interface PlatformRunSessionWorkflowDeps {
  readonly contextAssembler: ContextAssemblerPort;
  readonly runtimeDriver: AgentRuntimeDriver;
  readonly eventBus: EventBusPort;
  readonly auditSink: AuditSinkPort;
  readonly clock: RuntimeClockPort;
}

export class PlatformRunSessionWorkflow {
  constructor(private readonly deps: PlatformRunSessionWorkflowDeps) {}

  async start(req: AssembleRequest, eventTx?: unknown): Promise<RunId> {
    const context = await this.deps.contextAssembler.assemble(req);
    const runId = await this.deps.runtimeDriver.execute(context, eventTx);
    await this.deps.eventBus.publish({
      type: 'run.started',
      ts: this.deps.clock.nowMs(),
      runId,
      sessionId: context.sessionId,
      payload: { enabledToolCount: context.enabledTools.length },
    });
    await this.deps.auditSink.append({
      type: 'run.started',
      ts: this.deps.clock.nowMs(),
      payload: { runId, sessionId: context.sessionId },
    });
    return runId;
  }

  async abort(runId: RunId): Promise<void> {
    await this.deps.runtimeDriver.abort(runId);
    await this.deps.eventBus.publish({
      type: 'run.aborted',
      ts: this.deps.clock.nowMs(),
      runId,
    });
    await this.deps.auditSink.append({
      type: 'run.aborted',
      ts: this.deps.clock.nowMs(),
      payload: { runId },
    });
  }
}
