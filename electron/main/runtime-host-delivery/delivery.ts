import { homedir } from 'node:os';
import { join } from 'node:path';
import { app } from 'electron';
import type { HostEventBus } from '../../api/event-bus';
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
  readonly close: () => Promise<void>;
  readonly runtimeHostTransportPort: number;
}>;

export async function createRuntimeHostDelivery(
  hostEventBus: HostEventBus,
): Promise<RuntimeHostDelivery> {
  const workingDirectory = app.isPackaged ? process.resourcesPath : process.cwd();
  let launch: Parameters<typeof launchDirectRuntimeHost>[0];
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
      bootstrapBytes: buildRuntimeHostBootstrap({
        ...bootstrap,
        deliveryVerificationKey: issuer.verificationKey,
        parentCallbackBaseUrl: parentCallback.baseUrl,
        parentCallbackDispatchToken: parentCallback.dispatchToken,
        providerCredentialResolver: providerCredentialResolver && {
          endpoint: providerCredentialResolver.endpoint,
          authorization: providerCredentialResolver.authorization,
        },
      }),
      environment: runtimeHostLaunchEnvironment(),
    };
  } catch (error) {
    await providerCredentialResolver?.close().catch(() => undefined);
    await parentCallback?.close().catch(() => undefined);
    publishE2EBootstrapResolveFailure();
    throw error;
  }
  const launchRuntimeHost = async (): Promise<DirectRuntimeHost> =>
    launchDirectRuntimeHost(launch);
  return {
    launchRuntimeHost,
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
    ...(process.env.MATCHACLAW_SESSION_TRACE === '1' ? { MATCHACLAW_SESSION_TRACE: '1' } : {}),
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
