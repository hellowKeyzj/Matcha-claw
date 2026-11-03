import type { CloudAccountSession } from './session-store';
import type { CloudClientBootstrap } from './types';
import type { ProviderAccountsTransport } from '../runtime-host-delivery/transport/providers/accounts';
import type { ModelDraft, ProviderModelsTransport } from '../runtime-host-delivery/transport/providers/models';
import {
  deleteProviderPrivateAccount,
  storeProviderPrivateAccount,
  type ProviderAccountIntent,
} from '../providers/private-auth';
import type { createProviderCallObserver } from '../providers/private-auth';
import { logger } from '../../utils/logger';

const ACCOUNT_ID = 'matcha-cloud';
const ACCOUNT_LABEL = 'Matcha Cloud';

type SyncDependencies = Readonly<{
  fetchClientBootstrap(token: string): Promise<CloudClientBootstrap>;
  providerAccountsTransport: ProviderAccountsTransport;
  providerModelsTransport: ProviderModelsTransport;
  awaitProviderCall: ReturnType<typeof createProviderCallObserver>;
  onChanged?(): void;
}>;

export type CloudProviderSync = Readonly<{
  reconcile(
    session: CloudAccountSession | null,
    assertCurrent?: () => void,
    signals?: Readonly<{ bootstrap: AbortSignal; observation: AbortSignal }>,
  ): Promise<void>;
}>;

type SyncState = string | null;

export function createCloudProviderSync(deps: SyncDependencies): CloudProviderSync {
  let active: SyncState = null;
  let queue = Promise.resolve();

  const reconcile: CloudProviderSync['reconcile'] = (session, assertOwner, signals) => {
    const assertCurrent = () => { assertOwner?.(); };
    const currentDeps: SyncDependencies = signals ? {
      ...deps,
      awaitProviderCall: (receipt, command) => deps.awaitProviderCall(receipt, command, signals.observation),
    } : deps;
    const task = queue.then(async () => {
      try {
        assertCurrent();
        const bootstrap = session ? await fetchBootstrap(deps, session.accessToken, signals?.bootstrap) : null;
        assertCurrent();
        const next = await reconcileNow(currentDeps, session, bootstrap, active, assertCurrent);
        assertCurrent();
        active = next;
      } catch {
        try { assertCurrent(); } catch { return; }
        logger.warn('Cloud provider sync failed');
      }
    });
    queue = task.catch(() => undefined);
    return task;
  };

  return { reconcile };
}

async function fetchBootstrap(deps: SyncDependencies, token: string, signal?: AbortSignal): Promise<CloudClientBootstrap> {
  if (!signal) return deps.fetchClientBootstrap(token);
  signal.throwIfAborted();
  let onAbort: () => void = () => {};
  const aborted = new Promise<never>((_, reject) => {
    onAbort = () => reject(signal.reason);
    signal.addEventListener('abort', onAbort, { once: true });
  });
  try {
    // Only bootstrap waiting is revocable; admitted private writes keep their original drain.
    return await Promise.race([deps.fetchClientBootstrap(token), aborted]);
  } finally {
    signal.removeEventListener('abort', onAbort);
  }
}

async function reconcileNow(
  deps: SyncDependencies,
  session: CloudAccountSession | null,
  bootstrap: CloudClientBootstrap | null,
  active: SyncState,
  assertCurrent: () => void,
): Promise<SyncState> {
  if (!session || !bootstrap) {
    await removeCloudProvider(deps, active, assertCurrent);
    return null;
  }
  const owner = session.user.id.toString();
  if (active && active !== owner) {
    await removeCloudProvider(deps, active, assertCurrent);
    assertCurrent();
  }
  if (!isUsableBootstrap(bootstrap)) {
    await removeCloudProvider(deps, owner, assertCurrent);
    return null;
  }
  const account = await accountFromBootstrap(deps.providerAccountsTransport, bootstrap);
  assertCurrent();
  if (!account) return active;
  const stored = await storeProviderPrivateAccount(
    { transport: deps.providerAccountsTransport, awaitProviderCall: deps.awaitProviderCall, assertCurrent },
    account,
    apiKeyFromBootstrap(bootstrap),
  );
  // An admitted private transaction keeps its own settlement even after admission is revoked.
  assertCurrent();
  if (stored.status !== 'stored') {
    logger.warn(`Cloud provider account sync failed: ${stored.status}`);
    return active;
  }
  deps.onChanged?.();
  await replaceDiscoveredModels(deps, assertCurrent);
  return owner;
}

function isUsableBootstrap(bootstrap: CloudClientBootstrap): boolean {
  const openai = bootstrap.clients.openai;
  return bootstrap.ready
    && !bootstrap.needsSetup
    && Boolean(openai?.baseUrl.trim())
    && Boolean(apiKeyFromBootstrap(bootstrap)?.trim());
}

function apiKeyFromBootstrap(bootstrap: CloudClientBootstrap): string | undefined {
  return bootstrap.clients.openai?.apiKey ?? bootstrap.apiKey?.key;
}

async function accountFromBootstrap(
  transport: ProviderAccountsTransport,
  bootstrap: CloudClientBootstrap,
): Promise<ProviderAccountIntent | null> {
  const account = {
    id: ACCOUNT_ID,
    provider: 'custom',
    label: ACCOUNT_LABEL,
    enabled: true,
    kind: 'chat',
    endpoint: bootstrap.clients.openai?.baseUrl.trim() || bootstrap.baseUrl.trim(),
    protocol: 'openAiCompletions',
    authMode: 'apiKey',
    revision: 1,
  } satisfies ProviderAccountIntent;
  const current = await getAccount(transport);
  if (current.status === 404) return account;
  if (current.status !== 200 || !isCloudProviderAccount(current.body)) {
    logger.warn(`Cloud provider account lookup failed: ${current.status}`);
    return null;
  }
  return {
    ...account,
    revision: sameCloudProviderAccount(current.body.account, account)
      ? current.body.account.revision
      : current.body.account.revision + 1,
  };
}

async function replaceDiscoveredModels(deps: SyncDependencies, assertCurrent: () => void): Promise<void> {
  const transport = deps.providerModelsTransport;
  assertCurrent();
  const discovery = await transport.discover(ACCOUNT_ID);
  assertCurrent();
  if (discovery.status !== 202) {
    logger.warn(`Cloud provider model discovery failed: ${discovery.status}`);
    return;
  }
  const receipt = discovery.body;
  const discovered = await deps.awaitProviderCall(receipt, 'providerModels.discover');
  assertCurrent();
  if (discovered.callId !== receipt.callId || discovered.module !== 'provider'
    || discovered.command !== 'providerModels.discover'
    || discovered.detail.kind !== 'discoverModels' || discovered.detail.accountId !== ACCOUNT_ID) {
    throw new Error('Cloud provider discovery call identity is invalid');
  }
  if (discovered.status !== 'succeeded' || discovered.detail.phase !== 'terminal'
    || discovered.detail.outcome !== 'discovered' || discovered.detail.count === null) {
    logger.warn('Cloud provider model discovery result was not confirmed');
    return;
  }
  const result = await transport.readDiscoveryResult(receipt.callId, ACCOUNT_ID);
  assertCurrent();
  if (result.status !== 200) {
    logger.warn(`Cloud provider model discovery result failed: ${result.status}`);
    return;
  }
  if (result.body.models.length !== discovered.detail.count) {
    logger.warn('Cloud provider model discovery count did not match the completed call');
    return;
  }
  let models = result.body.models;
  const unknownCount = models.filter((model) => model.capabilities.length === 0).length;
  if (unknownCount > 0) {
    const current = await transport.read();
    assertCurrent();
    if (current.status !== 200) {
      logger.warn(`Cloud provider model catalog lookup failed: ${current.status}`);
      return;
    }
    const saved = new Map<string, ModelDraft>(current.body.models
      .filter((model) => model.accountId === ACCOUNT_ID)
      .map(({ accountId: _accountId, label: _label, ...model }) => [model.modelId, model]));
    models = result.body.models.flatMap((model) => {
      const configured = model.capabilities.length > 0 ? model : saved.get(model.modelId);
      return configured ? [configured] : [];
    });
    logger.warn('Cloud provider models with unknown capabilities', {
      discovered: result.body.models.length,
      unknown: unknownCount,
      skipped: result.body.models.length - models.length,
    });
    if (models.length === 0) return;
  }
  const replacement = await transport.execute({
    id: 'provider.models',
    operationId: 'providerModels.replace',
    scope: { kind: 'provider-model-catalog' },
    target: { kind: 'provider-models' },
    input: { kind: 'replace', accountId: ACCOUNT_ID, models },
  });
  assertCurrent();
  if (replacement.status !== 202) {
    logger.warn(`Cloud provider model sync failed: ${replacement.status}`);
    return;
  }
  const call = await deps.awaitProviderCall(replacement.body, 'providerModels.replace');
  assertCurrent();
  if (call.callId !== replacement.body.callId || call.module !== 'provider'
    || call.command !== 'providerModels.replace'
    || call.detail.kind !== 'replaceModels' || call.detail.accountId !== ACCOUNT_ID) {
    throw new Error('Cloud provider model call identity is invalid');
  }
  if (call.status !== 'succeeded' || call.detail.phase !== 'terminal' || call.detail.outcome !== 'stored'
    || call.detail.persisted !== 'confirmed' || call.detail.commit !== 'committed') {
    logger.warn('Cloud provider model sync result was not confirmed');
    return;
  }
  deps.onChanged?.();
}

async function getAccount(transport: ProviderAccountsTransport): ReturnType<ProviderAccountsTransport['execute']> {
  return await transport.execute({
    id: 'provider.accounts',
    operationId: 'providerAccounts.get',
    scope: { kind: 'provider-account-catalog' },
    target: { kind: 'provider-accounts' },
    input: { kind: 'get', accountId: ACCOUNT_ID },
  });
}

async function removeCloudProvider(deps: SyncDependencies, active: SyncState, assertCurrent: () => void): Promise<void> {
  assertCurrent();
  const listed = await getAccount(deps.providerAccountsTransport);
  assertCurrent();
  if (listed.status === 404) return;
  if (listed.status !== 200 || !isCloudProviderAccount(listed.body)) {
    if (active) logger.warn(`Cloud provider cleanup lookup failed: ${listed.status}`);
    return;
  }
  const deleted = await deleteProviderPrivateAccount(
    { transport: deps.providerAccountsTransport, awaitProviderCall: deps.awaitProviderCall, assertCurrent },
    ACCOUNT_ID,
    listed.body.account.revision,
  );
  if (deleted.status !== 'deleted') {
    logger.warn(`Cloud provider cleanup failed: ${deleted.status}`);
  } else {
    deps.onChanged?.();
  }
}

function isCloudProviderAccount(value: unknown): value is Readonly<{ account: ProviderAccountIntent }> {
  return isRecord(value)
    && isRecord(value.account)
    && value.account.id === ACCOUNT_ID
    && value.account.provider === 'custom'
    && typeof value.account.label === 'string'
    && typeof value.account.enabled === 'boolean'
    && (value.account.kind === undefined || value.account.kind === 'chat')
    && (value.account.endpoint === undefined || typeof value.account.endpoint === 'string')
    && (value.account.protocol === undefined || value.account.protocol === 'openAiCompletions')
    && value.account.authMode === 'apiKey'
    && typeof value.account.revision === 'number';
}

function sameCloudProviderAccount(current: ProviderAccountIntent, next: ProviderAccountIntent): boolean {
  return current.provider === next.provider
    && current.label === next.label
    && current.enabled === next.enabled
    && (current.kind ?? 'chat') === next.kind
    && current.endpoint === next.endpoint
    && current.protocol === next.protocol
    && current.authMode === next.authMode;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}
