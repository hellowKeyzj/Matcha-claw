import { logger } from '../utils/logger';
import { LifecycleSupersededError } from './lifecycle-controller';
import { getGatewayStartupRecoveryAction } from './startup-recovery';

export interface ExistingGatewayInfo {
  port: number;
  externalToken?: string;
}

type StartupHooks = {
  port: number;
  shouldWaitForPortFree: boolean;
  maxStartAttempts?: number;
  resetStartupStderrLines: () => void;
  getStartupStderrLines: () => string[];
  assertLifecycle: (phase: string) => void;
  findExistingGateway: (port: number) => Promise<ExistingGatewayInfo | null>;
  waitForControlReady: (port: number, externalToken?: string) => Promise<void>;
  onConnectedToExistingGateway: () => void;
  waitForPortFree: (port: number) => Promise<void>;
  startProcess: () => Promise<void>;
  waitForPortReady: (port: number) => Promise<void>;
  onManagedGatewayPortReady: () => void;
  onConnectedToManagedGateway: () => void;
  runDoctorRepair: () => Promise<boolean>;
  onDoctorRepairSuccess: () => void;
  delay: (ms: number) => Promise<void>;
};

export async function runGatewayStartupSequence(hooks: StartupHooks): Promise<void> {
  let configRepairAttempted = false;
  let startAttempts = 0;
  const maxStartAttempts = hooks.maxStartAttempts ?? 3;

  while (true) {
    startAttempts++;
    const attemptStartedAt = Date.now();
    const stageDurations: Record<string, number> = {};
    const measureStage = async <T>(stageName: string, runner: () => Promise<T>): Promise<T> => {
      const stageStartedAt = Date.now();
      try {
        return await runner();
      } finally {
        stageDurations[stageName] = Date.now() - stageStartedAt;
      }
    };
    hooks.assertLifecycle('start');
    hooks.resetStartupStderrLines();

    try {
      logger.debug(`Gateway startup attempt ${startAttempts}/${maxStartAttempts} begin`);
      logger.debug('Checking for existing Gateway...');
      const existing = await measureStage('find-existing', async () => {
        return await hooks.findExistingGateway(hooks.port);
      });
      hooks.assertLifecycle('start/find-existing');
      if (existing) {
        logger.debug(`Found existing Gateway on port ${existing.port}`);
        await measureStage('wait-control-ready-existing', async () => {
          await hooks.waitForControlReady(existing.port, existing.externalToken);
        });
        hooks.assertLifecycle('start/wait-control-ready-existing');
        hooks.onConnectedToExistingGateway();
        logger.info(
          `Gateway startup attempt ${startAttempts} completed via existing gateway (totalMs=${Date.now() - attemptStartedAt}, stages=${JSON.stringify(stageDurations)})`,
        );
        return;
      }

      logger.debug('No existing Gateway found, starting new process...');

      if (hooks.shouldWaitForPortFree) {
        await measureStage('wait-port-free', async () => {
          await hooks.waitForPortFree(hooks.port);
        });
        hooks.assertLifecycle('start/wait-port');
      }

      await measureStage('start-process', async () => {
        await hooks.startProcess();
      });
      hooks.assertLifecycle('start/start-process');

      await measureStage('wait-port-ready', async () => {
        await hooks.waitForPortReady(hooks.port);
      });
      hooks.assertLifecycle('start/wait-port-ready');
      hooks.onManagedGatewayPortReady();

      await measureStage('wait-control-ready', async () => {
        await hooks.waitForControlReady(hooks.port);
      });
      hooks.assertLifecycle('start/wait-control-ready');

      hooks.onConnectedToManagedGateway();
      logger.info(
        `Gateway startup attempt ${startAttempts} completed via managed gateway (totalMs=${Date.now() - attemptStartedAt}, stages=${JSON.stringify(stageDurations)})`,
      );
      return;
    } catch (error) {
      if (error instanceof LifecycleSupersededError) {
        throw error;
      }

      logger.warn(
        `Gateway startup attempt ${startAttempts} failed (totalMs=${Date.now() - attemptStartedAt}, stages=${JSON.stringify(stageDurations)})`,
      );

      const recoveryAction = getGatewayStartupRecoveryAction({
        startupError: error,
        startupStderrLines: hooks.getStartupStderrLines(),
        configRepairAttempted,
        attempt: startAttempts,
        maxAttempts: maxStartAttempts,
      });

      if (recoveryAction === 'repair') {
        configRepairAttempted = true;
        logger.warn(
          'Detected invalid OpenClaw config during Gateway startup; running doctor repair before retry',
        );
        const repaired = await hooks.runDoctorRepair();
        if (repaired) {
          logger.info('OpenClaw doctor repair completed; retrying Gateway startup');
          hooks.onDoctorRepairSuccess();
          continue;
        }
        logger.error('OpenClaw doctor repair failed; not retrying Gateway startup');
      }

      if (recoveryAction === 'retry') {
        logger.warn(`Transient start error: ${String(error)}. Retrying... (${startAttempts}/${maxStartAttempts})`);
        await hooks.delay(1000);
        continue;
      }

      throw error;
    }
  }
}
