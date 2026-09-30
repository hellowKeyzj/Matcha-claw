import type { CloudAccountSession } from './session-store';
import type { CloudClientBootstrap } from './types';
import type { ProviderAccountsTransport } from '../runtime-host-delivery/transport/providers/accounts';
import type {
  ProviderModelCapability,
  ProviderModelsTransport,
} from '../runtime-host-delivery/transport/providers/models';
import {
  deleteProviderPrivateAccount,
  storeProviderPrivateAccount,
  type ProviderAccountIntent,
} from '../ipc/provider-private-auth';
import { decodeCallReceipt } from '../../../src/types/call-log/receipt';
import type { createProviderCallObserver } from '../ipc/provider-call-observation';
import { logger } from '../../utils/logger';

const ACCOUNT_ID = 'matcha-cloud';
const ACCOUNT_LABEL = 'Matcha Cloud';

type SyncDependencies = Readonly<{
  fetchClientBootstrap(token: string): Promise<CloudClientBootstrap>;
  providerAccountsTransport: ProviderAccountsTransport;
  providerModelsTransport: ProviderModelsTransport;
  awaitProviderCall: ReturnType<typeof createProviderCallObserver>;
}>;

type ModelDraft = Readonly<{
  modelId: string;
  capabilities: readonly ProviderModelCapability[];
  contextWindow?: number;
  maxTokens?: number;
  timeoutMs?: number;
  aspectRatio?: string;
  resolution?: string;
  quality?: string;
}>;

export type CloudProviderSync = Readonly<{
  reconcile(session: CloudAccountSession | null): Promise<void>;
}>;

type SyncState = string | null;

export function createCloudProviderSync(deps: SyncDependencies): CloudProviderSync {
  let active: SyncState = null;
  let queue = Promise.resolve();

  const enqueue = (session: CloudAccountSession | null) => {
    queue = queue.catch(() => undefined).then(async () => {
      try {
        active = await reconcileNow(deps, session, active);
      } catch {
        logger.warn('Cloud provider sync failed');
      }
    });
    return queue;
  };

  return { reconcile: enqueue };
}

async function reconcileNow(
  deps: SyncDependencies,
  session: CloudAccountSession | null,
  active: SyncState,
): Promise<SyncState> {
  if (!session) {
    await removeCloudProvider(deps, active);
    return null;
  }
  const owner = session.user.id.toString();
  if (active && active !== owner) await removeCloudProvider(deps, active);
  const bootstrap = await deps.fetchClientBootstrap(session.accessToken);
  if (!isUsableBootstrap(bootstrap)) {
    await removeCloudProvider(deps, owner);
    return null;
  }
  const account = await accountFromBootstrap(deps.providerAccountsTransport, bootstrap, owner);
  if (!account) return active;
  const stored = await storeProviderPrivateAccount(
    { transport: deps.providerAccountsTransport, awaitProviderCall: deps.awaitProviderCall },
    account,
    apiKeyFromBootstrap(bootstrap),
  );
  if (stored.status !== 'stored') {
    logger.warn(`Cloud provider account sync failed: ${stored.status}`);
    return active;
  }
  await replaceDiscoveredModels(deps);
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
  owner: string,
): Promise<ProviderAccountIntent | null> {
  const account = {
    id: ACCOUNT_ID,
    provider: 'custom',
    label: `${ACCOUNT_LABEL} (${owner})`,
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

async function replaceDiscoveredModels(deps: SyncDependencies): Promise<void> {
  const transport = deps.providerModelsTransport;
  const discovery = await transport.discover(ACCOUNT_ID);
  if (discovery.status !== 200 || !isModelDiscovery(discovery.body)) {
    logger.warn(`Cloud provider model discovery failed: ${discovery.status}`);
    return;
  }
  const replacement = await transport.execute({
    id: 'provider.models',
    operationId: 'providerModels.replace',
    scope: { kind: 'provider-model-catalog' },
    target: { kind: 'provider-models' },
    input: { kind: 'replace', accountId: ACCOUNT_ID, models: discovery.body.models },
  });
  if (replacement.status !== 202) {
    logger.warn(`Cloud provider model sync failed: ${replacement.status}`);
    return;
  }
  const call = await deps.awaitProviderCall(decodeCallReceipt(replacement.body), 'providerModels.replace');
  if (call.detail.kind !== 'replaceModels' || call.detail.accountId !== ACCOUNT_ID) {
    throw new Error('Cloud provider model call identity is invalid');
  }
  if (call.detail.phase !== 'terminal' || call.detail.outcome !== 'stored'
    || call.detail.persisted !== 'confirmed' || call.detail.commit !== 'committed') {
    logger.warn('Cloud provider model sync result was not confirmed');
  }
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

async function removeCloudProvider(deps: SyncDependencies, active: SyncState): Promise<void> {
  const listed = await getAccount(deps.providerAccountsTransport);
  if (listed.status === 404) return;
  if (listed.status !== 200 || !isCloudProviderAccount(listed.body)) {
    if (active) logger.warn(`Cloud provider cleanup lookup failed: ${listed.status}`);
    return;
  }
  const deleted = await deleteProviderPrivateAccount(
    { transport: deps.providerAccountsTransport, awaitProviderCall: deps.awaitProviderCall },
    ACCOUNT_ID,
    listed.body.account.revision,
  );
  if (deleted.status !== 'deleted') {
    logger.warn(`Cloud provider cleanup failed: ${deleted.status}`);
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

function isModelDiscovery(value: unknown): value is Readonly<{ models: readonly ModelDraft[] }> {
  return isRecord(value) && Array.isArray(value.models) && value.models.every(isModelDraft);
}

function isModelDraft(value: unknown): value is ModelDraft {
  return isRecord(value)
    && typeof value.modelId === 'string'
    && Array.isArray(value.capabilities)
    && value.capabilities.every(isProviderModelCapability)
    && optionalNumber(value.contextWindow)
    && optionalNumber(value.maxTokens)
    && optionalNumber(value.timeoutMs)
    && optionalString(value.aspectRatio)
    && optionalString(value.resolution)
    && optionalString(value.quality);
}

function isProviderModelCapability(value: unknown): value is ProviderModelCapability {
  return value === 'chat'
    || value === 'imageUnderstand'
    || value === 'imageGenerate'
    || value === 'videoGenerate'
    || value === 'musicGenerate'
    || value === 'tts'
    || value === 'transcribe';
}

function optionalNumber(value: unknown): boolean {
  return value === undefined || typeof value === 'number';
}

function optionalString(value: unknown): boolean {
  return value === undefined || typeof value === 'string';
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}
