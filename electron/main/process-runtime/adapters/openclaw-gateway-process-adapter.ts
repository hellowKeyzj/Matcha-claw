import { GatewayControlReadinessBudgetError } from '../../gateway-control-ready-probe';
import type { GatewayManager } from '../openclaw-gateway/manager';
import type {
  LocalProcessAdapter,
  LocalProcessLaunchPlan,
  LocalProcessLogEvent,
  LocalProcessReadiness,
  LocalProcessReadinessContext,
  LocalProcessStartContext,
  LocalProcessStartFailureContext,
  LocalProcessStartFailureRecovery,
  LocalProcessState,
  LocalProcessCrashEvent,
  LocalProcessAutoRestartHaltedEvent,
  LocalProcessAutoRestartScheduledEvent,
} from '../contracts';
import {
  createGatewayLaunchContext,
  loadHostBootstrapSettings,
  prepareGatewayRuntimeBeforeLaunch,
  type GatewayLaunchPlan,
} from '../openclaw-gateway/config-sync';
import { waitForGatewayPortReady } from '../openclaw-gateway/port-readiness';
import { buildGatewayLaunchPlan } from '../openclaw-gateway/process-launcher';
import {
  findExistingGatewayProcess,
  runOpenClawDoctorRepair,
  terminateGatewayProcessIds,
  unloadLaunchctlGatewayService,
  waitForPortFree,
  warmupManagedPythonReadiness,
} from '../openclaw-gateway/supervisor';
import { getGatewayStartupRecoveryAction } from '../openclaw-gateway/startup-recovery';
import {
  classifyGatewayStderrMessage,
  recordGatewayStartupStderrLine,
  shouldSuppressGatewayStderrRepeat,
} from '../openclaw-gateway/startup-stderr';
import { logger } from '../../../utils/logger';

const MANAGED_GATEWAY_CONTROL_READY_TIMEOUT_MS = 60_000;

type GatewayPrelaunchRefreshReason =
  | 'doctor-repair-updated-runtime-config'
  | 'prelaunch-failed-before-launch-plan';

function classifyGatewayStdoutMessage(line: string): LocalProcessLogEvent {
  return { level: 'drop', message: line.trim() };
}

function resolveAttachedGatewayPid(plan?: LocalProcessLaunchPlan | null): number | undefined {
  if (plan?.kind !== 'external' || plan.metadata?.attachedToExistingGateway !== true) {
    return undefined;
  }
  return typeof plan.pid === 'number' ? plan.pid : undefined;
}

export interface OpenClawGatewayProcessAdapterOptions {
  readonly gatewayManager: GatewayManager;
  readonly maxStartAttempts?: number;
  readonly delay?: (ms: number) => Promise<void>;
}

export class OpenClawGatewayProcessAdapter implements LocalProcessAdapter {
  readonly id = 'openclaw-gateway';
  readonly displayName = 'OpenClaw gateway';
  readonly externalController = {
    stop: async () => {
      await this.stopAttachedOwnedGateway(this.currentLaunchPlan);
    },
  };

  private readonly gatewayManager: GatewayManager;
  private readonly maxStartAttempts: number;
  private readonly delay: (ms: number) => Promise<void>;
  private processExitCode: number | null = null;
  private recentStartupStderrLines: string[] = [];
  private configRepairAttempted = false;
  private readonly stderrDedupCounter = new Map<string, number>();
  private lastSpawnSummary: string | null = null;
  private currentLaunchPlan: LocalProcessLaunchPlan | null = null;
  private completedGatewayLaunchPlan: GatewayLaunchPlan | null = null;
  private gatewayPrelaunchRefreshReason: GatewayPrelaunchRefreshReason | null = null;

  constructor(options: OpenClawGatewayProcessAdapterOptions) {
    this.gatewayManager = options.gatewayManager;
    this.maxStartAttempts = options.maxStartAttempts ?? 3;
    this.delay = options.delay ?? (async (ms) => {
      await new Promise((resolve) => setTimeout(resolve, ms));
    });
  }

  async prepareLaunch(context: LocalProcessStartContext): Promise<LocalProcessLaunchPlan> {
    const status = this.gatewayManager.getStatus();
    if (context.attempt === 1) {
      this.completedGatewayLaunchPlan = null;
      this.gatewayPrelaunchRefreshReason = null;
      warmupManagedPythonReadiness();
      this.configRepairAttempted = false;
      this.gatewayManager.markStarting();
    }

    if (context.attempt === 1 || this.gatewayPrelaunchRefreshReason || !this.completedGatewayLaunchPlan) {
      let launchPlan: GatewayLaunchPlan;
      try {
        launchPlan = await prepareGatewayRuntimeBeforeLaunch(this.gatewayManager.getRuntimeHostManager());
      } catch (error) {
        this.gatewayPrelaunchRefreshReason = 'prelaunch-failed-before-launch-plan';
        throw error;
      }
      context.assertActive?.();
      this.completedGatewayLaunchPlan = launchPlan;
      this.gatewayPrelaunchRefreshReason = null;
    }

    const launchPlan = this.completedGatewayLaunchPlan;
    if (!launchPlan) {
      throw new Error('Gateway launch plan is unavailable after prelaunch');
    }
    this.recentStartupStderrLines = [];
    this.stderrDedupCounter.clear();

    const existing = await findExistingGatewayProcess({
      port: status.port,
      ownedPid: status.pid,
      ...(context.assertActive
        ? { signal: context.signal, assertActive: context.assertActive }
        : {}),
    });
    context.assertActive?.();
    if (existing) {
      const plan = {
        kind: 'external',
        port: existing.port,
        ...(status.pid ? { pid: status.pid } : {}),
        metadata: {
          processState: 'running',
          attachedToExistingGateway: true,
          ...(existing.externalToken ? { externalToken: existing.externalToken } : {}),
        },
      } satisfies LocalProcessLaunchPlan;
      this.currentLaunchPlan = plan;
      return plan;
    }

    if (process.platform === 'win32') {
      await waitForPortFree(status.port);
      context.assertActive?.();
    }

    const appSettings = await loadHostBootstrapSettings();
    context.assertActive?.();
    const launchContext = await createGatewayLaunchContext(status.port, launchPlan, appSettings);
    context.assertActive?.();
    await unloadLaunchctlGatewayService();
    context.assertActive?.();
    this.processExitCode = null;

    const { plan, lastSpawnSummary } = buildGatewayLaunchPlan({
      port: status.port,
      launchContext,
      sanitizeSpawnArgs: (args) => this.sanitizeSpawnArgs(args),
    });
    this.lastSpawnSummary = lastSpawnSummary;
    this.currentLaunchPlan = plan;
    return plan;
  }

  async probeReadiness(
    plan: LocalProcessLaunchPlan,
    context?: LocalProcessReadinessContext,
  ): Promise<LocalProcessReadiness> {
    const readinessContext = context ?? {
      nowMs: () => Date.now(),
      signal: new AbortController().signal,
    };
    const port = plan.port ?? this.gatewayManager.getStatus().port;
    if (plan.kind === 'external') {
      try {
        await waitForGatewayPortReady({
          port,
          getProcessExitCode: () => null,
          signal: readinessContext.signal,
        });
        await this.gatewayManager.waitForControlReady(
          MANAGED_GATEWAY_CONTROL_READY_TIMEOUT_MS,
          port,
          plan.metadata?.externalToken as string | undefined,
        );
        return { status: 'ready', detail: 'attached to existing gateway' };
      } catch (error) {
        if (error instanceof GatewayControlReadinessBudgetError) {
          throw error;
        }
        return {
          ...(readinessContext.signal.aborted
            ? { status: 'not-ready', detail: 'readiness probe aborted' }
            : { status: 'error', error: error instanceof Error ? error.message : String(error) }),
        };
      }
    }

    try {
      await waitForGatewayPortReady({
        port,
        getProcessExitCode: () => this.processExitCode,
        signal: readinessContext.signal,
      });
      const previousState = this.gatewayManager.getStatus().processState;
      if (previousState !== 'running') {
        this.gatewayManager.markControlConnecting();
      }
      await this.gatewayManager.waitForControlReady(MANAGED_GATEWAY_CONTROL_READY_TIMEOUT_MS, port);
      if (previousState === 'running') {
        this.gatewayManager.markRunning();
      }
      return { status: 'ready', detail: 'control channel ready' };
    } catch (error) {
      if (error instanceof GatewayControlReadinessBudgetError) {
        throw error;
      }
      return {
        status: 'error',
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  async recoverStartFailure(context: LocalProcessStartFailureContext): Promise<LocalProcessStartFailureRecovery> {
    const recoveryAction = context.error instanceof GatewayControlReadinessBudgetError
      ? context.attempt < this.maxStartAttempts
        ? { action: 'retry', cleanup: 'keep-current' } as const
        : { action: 'fail', cleanup: 'keep-current' } as const
      : getGatewayStartupRecoveryAction({
        startupError: context.error,
        startupStderrLines: this.recentStartupStderrLines,
        configRepairAttempted: this.configRepairAttempted,
        attempt: context.attempt,
        maxAttempts: this.maxStartAttempts,
      });

    if (recoveryAction.action === 'repair') {
      this.configRepairAttempted = true;
      logger.warn('Detected invalid OpenClaw config during Gateway startup; running doctor repair before retry');
      const repaired = await runOpenClawDoctorRepair();
      if (repaired) {
        this.gatewayPrelaunchRefreshReason = 'doctor-repair-updated-runtime-config';
        logger.info('OpenClaw doctor repair completed; retrying Gateway startup');
        return { action: 'retry', cleanup: 'keep-current' };
      }
      logger.error('OpenClaw doctor repair failed; not retrying Gateway startup');
      return { action: 'fail', cleanup: 'keep-current' };
    }

    if (recoveryAction.action === 'retry') {
      logger.warn(
        `Transient Gateway startup error: ${context.error.message}. Keeping any current process attached before retrying (${context.attempt}/${this.maxStartAttempts})`,
      );
      await this.delayWithSignal(1000, context.signal);
      return recoveryAction;
    }

    logger.error(
      `Gateway start failed (port=${this.gatewayManager.getStatus().port}, spawn=${this.lastSpawnSummary ?? 'n/a'})`,
      context.error,
    );
    this.gatewayManager.markError(context.error.message, {
      preservePid: recoveryAction.cleanup === 'keep-current',
    });
    return recoveryAction;
  }

  async onLaunched(state: LocalProcessState): Promise<void> {
    this.gatewayManager.markLaunched(state.pid);
  }

  async onStarted(): Promise<void> {
    this.gatewayManager.markRunning();
  }

  async onStopped(state: LocalProcessState): Promise<void> {
    if (state.lifecycle === 'stopped') {
      this.gatewayManager.markStopped();
    }
  }

  async onCrashed(event: LocalProcessCrashEvent): Promise<void> {
    this.processExitCode = event.code;
    this.gatewayManager.markCrashed(event.message, event.code);
  }

  async onAutoRestartScheduled(event: LocalProcessAutoRestartScheduledEvent): Promise<void> {
    this.gatewayManager.markAutoRestartScheduled(event.attempt);
  }

  async onAutoRestartHalted(event: LocalProcessAutoRestartHaltedEvent): Promise<void> {
    this.gatewayManager.markAutoRestartHalted(
      'Failed to reconnect after maximum attempts',
      event.maxAttempts,
    );
  }

  classifyLog(line: string, stream: 'stdout' | 'stderr'): LocalProcessLogEvent {
    if (stream !== 'stderr') {
      return classifyGatewayStdoutMessage(line);
    }

    recordGatewayStartupStderrLine(this.recentStartupStderrLines, line);
    const classified = classifyGatewayStderrMessage(line);
    if (classified.level === 'drop') {
      return { level: 'drop', message: classified.normalized };
    }
    const dedup = shouldSuppressGatewayStderrRepeat(this.stderrDedupCounter, classified.normalized);
    if (dedup.suppress) {
      if (dedup.emitSummary) {
        return {
          level: 'debug',
          message: `(suppressed ${dedup.repeatCount} repeats) ${classified.normalized}`,
        };
      }
      return { level: 'drop', message: classified.normalized };
    }
    return classified.level === 'debug'
      ? { level: 'debug', message: classified.normalized }
      : { level: 'warn', message: classified.normalized };
  }

  private async delayWithSignal(ms: number, signal: AbortSignal): Promise<void> {
    if (signal.aborted) {
      throw new Error('Gateway startup recovery aborted');
    }
    await this.delay(ms);
    if (signal.aborted) {
      throw new Error('Gateway startup recovery aborted');
    }
  }

  private async stopAttachedOwnedGateway(plan: LocalProcessLaunchPlan | null): Promise<void> {
    const pid = resolveAttachedGatewayPid(plan);
    if (typeof pid !== 'number') {
      return;
    }
    await terminateGatewayProcessIds({
      port: plan?.port ?? this.gatewayManager.getStatus().port,
      pids: [String(pid)],
      reason: 'owned attached gateway',
    });
  }

  private sanitizeSpawnArgs(args: string[]): string[] {
    const sanitized = [...args];
    const tokenIdx = sanitized.indexOf('--token');
    if (tokenIdx !== -1 && tokenIdx + 1 < sanitized.length) {
      sanitized[tokenIdx + 1] = '[redacted]';
    }
    return sanitized;
  }
}

export function createOpenClawGatewayProcessAdapter(
  options: OpenClawGatewayProcessAdapterOptions,
): OpenClawGatewayProcessAdapter {
  return new OpenClawGatewayProcessAdapter(options);
}
