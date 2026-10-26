import { homedir } from 'node:os';
import { join } from 'node:path';
import { app } from 'electron';
import type { HostEventBus } from '../../api/event-bus';
import { observeWorldStorageRegistration, readWorldStorageBootstrap, type WorldPostgresConfiguration } from '../world/storage-config';
import { readInitialWorldBootstrap } from '../world/initial-config';
import { getPort } from '../../utils/config';
import { buildRuntimeHostBootstrap } from './bootstrap';
import { resolveRuntimeHostBootstrap } from './bootstrap-resources';
import { resolveRuntimeHostBinary } from './binary';
import { launchDirectRuntimeHost, type DirectRuntimeHost } from './direct-host';
import { createRuntimeHostDeliveryIssuer, type RuntimeHostDeliveryIssuer } from './issuer';
import { createParentCallbackReceiver, type ParentCallbackReceiver } from './parent-callback';
import {
  migrateLegacyProviderPrivateAuth,
  startProviderPrivateCredentialResolver,
  type ProviderPrivateCredentialResolver,
} from '../ipc/provider-private-auth';

const isE2EMode = process.env.MATCHACLAW_E2E === '1';
const legacyRuntimeHostDataDir = process.env.MATCHACLAW_RUNTIME_HOST_DATA_DIR?.trim()
  || process.env.OPENCLAW_CONFIG_DIR?.trim()
  || join(homedir(), '.openclaw');
const e2eStartupOutcomeKey = '__matchaclawE2EStartupOutcome';

type E2EProcess = typeof process & {
  [e2eStartupOutcomeKey]?: unknown;
};

export type RuntimeHostDelivery = Readonly<{
  readonly issuer: RuntimeHostDeliveryIssuer;
  readonly launchRuntimeHost: () => Promise<DirectRuntimeHost>;
  readonly validateWorldStorageBootstrap: (storage: WorldPostgresConfiguration, configuration?: Readonly<Record<string, unknown>>) => Promise<void>;
  readonly close: () => Promise<void>;
  readonly runtimeHostTransportPort: number;
}>;

export async function createRuntimeHostDelivery(
  hostEventBus: HostEventBus,
  lifecycle: Readonly<{
    signal: AbortSignal;
    onSpawn: (host: DirectRuntimeHost, closed: Promise<void>) => void;
  }>,
): Promise<RuntimeHostDelivery> {
  const workingDirectory = app.isPackaged ? process.resourcesPath : process.cwd();
  let launch: Omit<Parameters<typeof launchDirectRuntimeHost>[0], 'bootstrapBytes'>;
  let bootstrapInput: Parameters<typeof buildRuntimeHostBootstrap>[0];
  let providerCredentialResolver: ProviderPrivateCredentialResolver | undefined;
  let parentCallback: ParentCallbackReceiver | undefined;
  const issuer = createRuntimeHostDeliveryIssuer();
  let runtimeHostTransportPort: number;
  try {
    const bootstrap = resolveRuntimeHostBootstrap();
    parentCallback = await createParentCallbackReceiver(hostEventBus);
    await migrateLegacyProviderPrivateAuth(
      providerStoreMigrationEnvironment().MATCHACLAW_RUNTIME_HOST_PROVIDER_STORE_FILE,
      bootstrap.openClaw.stateDir
    );
    providerCredentialResolver = await startProviderPrivateCredentialResolver(bootstrap.openClaw.stateDir);
    runtimeHostTransportPort = bootstrap.runtimeHostTransportPort;
    launch = {
      executablePath: resolveRuntimeHostBinary({
        isPackaged: app.isPackaged,
        ...(app.isPackaged
          ? { resourcesPath: workingDirectory }
          : { projectRoot: workingDirectory }),
      }),
      workingDirectory,
      environment: runtimeHostLaunchEnvironment(),
    };
    bootstrapInput = {
        ...bootstrap,
        deliveryVerificationKey: issuer.verificationKey,
        parentCallbackBaseUrl: parentCallback.baseUrl,
        parentCallbackDispatchToken: parentCallback.dispatchToken,
        providerCredentialResolver: {
          endpoint: providerCredentialResolver.endpoint,
          authorization: providerCredentialResolver.authorization,
        },
        worldSourceAccess: {
          endpoint: providerCredentialResolver.endpoint,
          authorization: providerCredentialResolver.authorization,
        },
    };
  } catch (error) {
    await providerCredentialResolver?.close().catch(() => undefined);
    await parentCallback?.close().catch(() => undefined);
    publishE2EBootstrapResolveFailure();
    throw error;
  }
  const launchRuntimeHost = async (): Promise<DirectRuntimeHost> => {
    const storage = await readWorldStorageBootstrap();
    const initialWorld = await readInitialWorldBootstrap();
    const host = await launchDirectRuntimeHost({ ...launch, ...lifecycle, bootstrapBytes: buildRuntimeHostBootstrap({
      ...bootstrapInput, ...storage, ...(initialWorld ? { initialWorld } : {}),
    }) });
    host.onExit(observeWorldStorageRegistration(storage.worldStorageTargets.map((target) => target.storageId)));
    return host;
  };
  return {
    launchRuntimeHost,
    validateWorldStorageBootstrap: async (storage, configuration) => {
      const saved = await readWorldStorageBootstrap();
      if (configuration && configuration.storageId !== storage.storageId) {
        throw new Error('world.initial_storage_conflict');
      }
      buildRuntimeHostBootstrap({ ...bootstrapInput, worldPostgres: storage,
        worldStorageTargets: saved.worldStorageTargets.filter((target) => target.storageId !== storage.storageId),
        ...(configuration ? { initialWorld: configuration } : {}) });
    },
    close: async () => {
      await providerCredentialResolver?.close();
      await parentCallback?.close();
    },
    issuer,
    runtimeHostTransportPort,
  };
}

function runtimeHostLaunchEnvironment(): Readonly<Record<string, string>> {
  return {
    MATCHACLAW_RUNTIME_HOST_PORT: String(getPort('MATCHACLAW_RUNTIME_HOST')),
    MATCHACLAW_TRACE: process.env.MATCHACLAW_TRACE === '1' ? '1' : '0',
    ...(isE2EMode ? { MATCHACLAW_DEBUG_CRON_PROVIDER: '1' } : {}),
    ...providerStoreMigrationEnvironment(),
  };
}

function providerStoreMigrationEnvironment(): Readonly<Record<string, string>> {
  return {
    MATCHACLAW_RUNTIME_HOST_PROVIDER_STORE_FILE: process.env.MATCHACLAW_RUNTIME_HOST_PROVIDER_STORE_FILE
      || join(legacyRuntimeHostDataDir, 'matchaclaw-provider-accounts.json'),
    MATCHACLAW_RUNTIME_HOST_PROVIDER_MODELS_STORE_FILE: process.env.MATCHACLAW_RUNTIME_HOST_PROVIDER_MODELS_STORE_FILE
      || join(legacyRuntimeHostDataDir, 'matchaclaw-provider-models.json'),
    MATCHACLAW_RUNTIME_HOST_CAPABILITY_ROUTING_STORE_FILE: process.env.MATCHACLAW_RUNTIME_HOST_CAPABILITY_ROUTING_STORE_FILE
      || join(legacyRuntimeHostDataDir, 'matchaclaw-capability-routing.json'),
  };
}

function publishE2EBootstrapResolveFailure(): void {
  if (!isE2EMode || (process as E2EProcess)[e2eStartupOutcomeKey] !== undefined) return;

  Object.defineProperty(process as E2EProcess, e2eStartupOutcomeKey, {
    configurable: true,
    enumerable: false,
    value: Object.freeze({
      stage: 'bootstrap-resolve',
      outcome: 'BOOTSTRAP_RESOLVE_FAILED',
    }),
    writable: false,
  });
}
