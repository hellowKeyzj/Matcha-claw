import {
  createTransportStats,
  type RuntimeHostTransportStats,
} from '../runtime-host-server';
import { RuntimeJobQueue, RuntimeJobRegistry } from '../../core/jobs';
import {
  registerRuntimeLifecycleDefinitions,
  RuntimeHostLifecycle,
} from '../../core/lifecycle';
import type {
  RuntimeCommandExecutorPort,
  RuntimeFileSystemPort,
  RuntimeClockPort,
  RuntimeHttpClientPort,
  RuntimeIdGeneratorPort,
  RuntimeProcessControlPort,
  RuntimeProcessInfoPort,
  RuntimeSchedulerPort,
  RuntimeSystemEnvironmentPort,
  RuntimeTcpProbePort,
  RuntimeTimerPort,
} from '../../application/common/runtime-ports';
import { createRuntimeLogger, type RuntimeHostLogger, type RuntimeLogSink } from '../../shared/logger';
import type {
  GatewayDeviceCryptoPort,
  GatewayDeviceIdentityRepositoryPort,
} from '../../openclaw-bridge/client-auth-ports';
import {
  NodeGatewayDeviceCrypto,
  NodeGatewayDeviceIdentityRepository,
} from '../gateway-device-identity-adapters';
import type { RuntimeHostContainer } from '../container';
import {
  NodeRuntimeCommandExecutor,
  NodeRuntimeClock,
  ConsoleRuntimeLogSink,
  NodeRuntimeFileSystem,
  NodeRuntimeHttpClient,
  NodeRuntimeIdGenerator,
  NodeRuntimeProcessControl,
  NodeRuntimeProcessInfo,
  NodeRuntimeScheduler,
  NodeRuntimeSystemEnvironment,
  NodeRuntimeTcpProbe,
  NodeRuntimeTimer,
} from '../runtime-host-infrastructure-adapters';
import { RuntimeJobsService } from '../../application/runtime-host/runtime-jobs-service';
import { RuntimeLongTaskService } from '../../application/runtime-host/runtime-long-task-service';
import { BackgroundTaskManager } from '../../services/background-task-manager';
import type {
  RuntimeJobQueryPort,
  RuntimeLongTaskLookupPort,
  RuntimeLongTaskSubmissionPort,
} from '../../application/runtime-host/runtime-task-ports';

export interface RuntimeHostInfrastructure {
  readonly logger: RuntimeHostLogger;
  readonly lifecycle: RuntimeHostLifecycle;
  readonly jobRegistry: RuntimeJobRegistry;
  readonly jobQueue: RuntimeJobQueue;
  readonly transportStats: RuntimeHostTransportStats;
  readonly httpClient: RuntimeHttpClientPort;
  readonly processInfo: RuntimeProcessInfoPort;
  readonly processControl: RuntimeProcessControlPort;
  readonly systemEnvironment: RuntimeSystemEnvironmentPort;
  readonly commandExecutor: RuntimeCommandExecutorPort;
  readonly fileSystem: RuntimeFileSystemPort;
  readonly clock: RuntimeClockPort;
  readonly idGenerator: RuntimeIdGeneratorPort;
  readonly gatewayDeviceCrypto: GatewayDeviceCryptoPort;
  readonly gatewayDeviceIdentityRepository: GatewayDeviceIdentityRepositoryPort;
  readonly scheduler: RuntimeSchedulerPort;
  readonly tcpProbe: RuntimeTcpProbePort;
  readonly timer: RuntimeTimerPort;
}

export function registerRuntimeHostInfrastructure(container: RuntimeHostContainer): void {
  container.register('runtime.httpClient', () => new NodeRuntimeHttpClient());
  container.register('runtime.processInfo', () => new NodeRuntimeProcessInfo());
  container.register('runtime.processControl', () => new NodeRuntimeProcessControl());
  container.register('runtime.systemEnvironment', () => new NodeRuntimeSystemEnvironment());
  container.register('runtime.commandExecutor', () => new NodeRuntimeCommandExecutor());
  container.register('runtime.fileSystem', () => new NodeRuntimeFileSystem());
  container.register('runtime.clock', () => new NodeRuntimeClock());
  container.register('runtime.logSink', () => new ConsoleRuntimeLogSink());
  container.register('logger', (scope) => createRuntimeLogger(
    'runtime-host-app',
    scope.resolve<RuntimeClockPort>('runtime.clock'),
    scope.resolve<RuntimeLogSink>('runtime.logSink'),
  ));
  container.register('runtime.idGenerator', () => new NodeRuntimeIdGenerator());
  container.register('gateway.deviceCrypto', () => new NodeGatewayDeviceCrypto());
  container.register('gateway.deviceIdentityRepository', (scope) => new NodeGatewayDeviceIdentityRepository(
    scope.resolve('gateway.deviceCrypto'),
    scope.resolve('runtime.clock'),
  ));
  container.register('runtime.scheduler', () => new NodeRuntimeScheduler());
  container.register('runtime.tcpProbe', () => new NodeRuntimeTcpProbe());
  container.register('runtime.timer', (scope) => new NodeRuntimeTimer(scope.resolve('runtime.scheduler')));
  container.register('lifecycle', (scope) => new RuntimeHostLifecycle(scope.resolve('logger')));
  container.register('jobRegistry', () => new RuntimeJobRegistry());
  container.register('jobQueue', (scope) => new RuntimeJobQueue(
    scope.resolve('jobRegistry'),
    scope.resolve('logger'),
    scope.resolve('runtime.scheduler'),
    scope.resolve('runtime.clock'),
  ));
  container.register('runtimeHost.jobsService', (scope) => new RuntimeJobsService(
    scope.resolve<RuntimeJobQueryPort>('runtime.jobQueries'),
  ));
  container.register('runtimeHost.longTaskService', (scope) => new RuntimeLongTaskService(
    scope.resolve<RuntimeJobQueue>('jobQueue'),
  ));
  container.register('runtime.tasks', (scope) => scope.resolve<RuntimeLongTaskSubmissionPort>('runtimeHost.longTaskService'));
  container.register('runtime.taskLookup', (scope) => scope.resolve<RuntimeLongTaskLookupPort>('jobQueue'));
  container.register('runtime.jobQueries', (scope) => scope.resolve<RuntimeJobQueryPort>('jobQueue'));
  container.register('runtime.backgroundTasks', (scope) => new BackgroundTaskManager({
    jobQueries: scope.resolve<RuntimeJobQueryPort>('runtime.jobQueries'),
    timer: scope.resolve<RuntimeTimerPort>('runtime.timer'),
    nowMs: () => scope.resolve<RuntimeClockPort>('runtime.clock').nowMs(),
  }));
  container.registerValue('transportStats', createTransportStats());
}

export function resolveRuntimeHostInfrastructure(container: RuntimeHostContainer): RuntimeHostInfrastructure {
  return {
    logger: container.resolve<RuntimeHostLogger>('logger'),
    lifecycle: container.resolve<RuntimeHostLifecycle>('lifecycle'),
    jobRegistry: container.resolve<RuntimeJobRegistry>('jobRegistry'),
    jobQueue: container.resolve<RuntimeJobQueue>('jobQueue'),
    transportStats: container.resolve<RuntimeHostTransportStats>('transportStats'),
    httpClient: container.resolve<RuntimeHttpClientPort>('runtime.httpClient'),
    processInfo: container.resolve<RuntimeProcessInfoPort>('runtime.processInfo'),
    processControl: container.resolve<RuntimeProcessControlPort>('runtime.processControl'),
    systemEnvironment: container.resolve<RuntimeSystemEnvironmentPort>('runtime.systemEnvironment'),
    commandExecutor: container.resolve<RuntimeCommandExecutorPort>('runtime.commandExecutor'),
    fileSystem: container.resolve<RuntimeFileSystemPort>('runtime.fileSystem'),
    clock: container.resolve<RuntimeClockPort>('runtime.clock'),
    idGenerator: container.resolve<RuntimeIdGeneratorPort>('runtime.idGenerator'),
    gatewayDeviceCrypto: container.resolve<GatewayDeviceCryptoPort>('gateway.deviceCrypto'),
    gatewayDeviceIdentityRepository: container.resolve<GatewayDeviceIdentityRepositoryPort>('gateway.deviceIdentityRepository'),
    scheduler: container.resolve<RuntimeSchedulerPort>('runtime.scheduler'),
    tcpProbe: container.resolve<RuntimeTcpProbePort>('runtime.tcpProbe'),
    timer: container.resolve<RuntimeTimerPort>('runtime.timer'),
  };
}

export function registerRuntimeHostInfrastructureLifecycle(
  infrastructure: RuntimeHostInfrastructure,
): void {
  registerRuntimeLifecycleDefinitions(infrastructure.lifecycle, {
    cleanupTasks: [
      {
        name: 'jobs.queue',
        run: async () => {
          await infrastructure.jobQueue.stop();
        },
      },
    ],
  });
}
