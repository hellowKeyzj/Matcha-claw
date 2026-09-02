import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { createServer, type Server, type ServerResponse } from 'node:http';
import { mkdir, open, readFile, rename, rm } from 'node:fs/promises';
import { platform } from 'node:process';
import { dirname, join } from 'node:path';
import { app, BrowserWindow, ipcMain, safeStorage, shell } from 'electron';

import type { ProviderAccountsTransport } from '../runtime-host-delivery/transport/providers/accounts';
import {
  ProviderMutationReceiptUnavailableError,
  type ProviderMutationCommittedAccountResponse,
  type ProviderMutationCommittedResponse,
  type ProviderMutationCommitUnknownResponse,
  type ProviderMutationReceipt,
} from '../runtime-host-delivery/transport/providers/mutation-receipt';
import { loginOpenAICodexOAuth } from '../../services/providers/oauth/openai-codex-oauth';
import {
  loginMiniMaxPortalOAuth,
  loginQwenPortalOAuth,
} from '../../services/providers/oauth/device-oauth-providers';

const STORE_FILE = 'provider-private-auth.v1.json';
const MAX_SECRET_BYTES = 16 * 1024;
const MAX_ID_BYTES = 128;
const MAX_PRIVATE_REQUEST_BYTES = 1024;
const MAX_AUTH_PROFILES_BYTES = 1024 * 1024;
const MAX_PROVIDER_KEY_BYTES = 256;
const AUTH_PROFILES_FILE = 'auth-profiles.json';
const OAUTH_ERROR_MESSAGE = 'Provider OAuth authentication failed';
const MUTATION_UNKNOWN_ERROR = 'Provider mutation commit outcome is unknown; reopen before retrying';

type PrivateResolverFailureCode =
  | 'invalid-request'
  | 'credential-missing'
  | 'credential-decrypt-failed'
  | 'credential-provider-mismatch'
  | 'credential-invalid'
  | 'auth-profile-read-invalid'
  | 'auth-profile-write-failed'
  | 'credential-store-unavailable'
  | 'unknown';

class ProviderPrivateResolverError extends Error {
  constructor(readonly code: PrivateResolverFailureCode, cause?: unknown) {
    super(code, cause === undefined ? undefined : { cause });
    this.name = 'ProviderPrivateResolverError';
  }
}

type Provider = 'openai' | 'minimax-portal' | 'minimax-portal-cn' | 'qwen-portal';
type AuthMode = 'apiKey' | 'oauthBrowser' | 'oauthDevice' | 'local';
type AccountKind = 'chat' | 'media';
type ApiProtocol = 'anthropicMessages' | 'googleGenerativeAi' | 'openAiCompletions' | 'openAiResponses';
type MediaProtocol = 'google' | 'openAi' | 'openRouter';
type PrivateStore = Record<string, string>;
type SecretRef = Readonly<{ source: 'env' | 'file' | 'exec'; provider: string; id: string }>;
type SecretInput = string | SecretRef;
type AuthProfile = Record<string, unknown>;
type AuthProfileOrder = Record<string, string[]>;
type AuthProfileLastGood = Record<string, string>;
type MutableAuthProfileStore = {
  version: 1;
  profiles: Record<string, AuthProfile>;
  order?: AuthProfileOrder;
  lastGood?: AuthProfileLastGood;
  [key: string]: unknown;
};
type AuthProfileStore = Readonly<MutableAuthProfileStore>;
type AccountIntent = Readonly<{
  id: string;
  provider: string;
  label: string;
  enabled: boolean;
  kind: AccountKind;
  endpoint?: string;
  protocol?: ApiProtocol;
  mediaProtocol?: MediaProtocol;
  authMode: AuthMode;
  revision: number;
}>;
type Flow = Readonly<{ flowId: string; account: AccountIntent; provider: Provider }>;

const activeFlows = new Map<string, Flow>();
const manualCodes = new Map<string, { resolve: (value: string) => void; reject: () => void }>();
let privateStoreWrite = Promise.resolve();
let authProfileWrite = Promise.resolve();

export type ProviderPrivateCredentialResolver = Readonly<{
  endpoint: string;
  authorization: string;
  close: () => Promise<void>;
}>;

export type ProviderCredentialStatusResponse = Readonly<{ hasKey: boolean }>;

export async function migrateLegacyProviderPrivateAuth(legacyProviderStoreFilePath: string, openClawStateDir: string): Promise<void> {
  const filePath = legacyProviderStoreFilePath.trim();
  if (!filePath || !safeStorage.isEncryptionAvailable()) return;
  const legacy = await readLegacyProviderStore(filePath);
  if (!legacy) return;
  for (const [accountId, key] of Object.entries(legacy.apiKeys)) {
    const account = legacy.accounts[accountId];
    const provider = isRecord(account) && isProviderName(account.vendorId) ? account.vendorId : undefined;
    if (!isId(accountId) || !provider || account.authMode !== 'api_key' || !isSecret(key)) continue;
    const reference = credentialReference(accountId);
    if (await credentialSnapshot(reference)) continue;
    try {
      await storeSecret(accountId, { kind: 'apiKey', provider, key });
      await applyPrivateProfile(reference, openClawProviderKey(provider, accountId, 'apiKey'), provider, 'apiKey', openClawStateDir);
    } catch {
      await removeCredentialReference(reference).catch(() => undefined);
    }
  }
}

export interface ProviderCredentialStatusTransport {
  hasApiKey(accountId: string): Promise<ProviderCredentialStatusResponse>;
}

export function createProviderCredentialStatusTransport(): ProviderCredentialStatusTransport {
  return {
    async hasApiKey(accountId: string): Promise<ProviderCredentialStatusResponse> {
      if (!isId(accountId)) throw new Error('Provider account request is invalid');
      const store = await readStore();
      return { hasKey: Object.hasOwn(store, credentialReference(accountId)) };
    },
  };
}

export function registerProviderPrivateAuthHandlers(
  getMainWindow: () => BrowserWindow | null,
  transport: ProviderAccountsTransport,
): void {
  ipcMain.handle('providers:storeAccount', async (_, input: unknown) => {
    const value = input as { account?: unknown; apiKey?: unknown };
    const account = parseAccount(value.account);
    if (!account || (account.authMode !== 'local' && value.apiKey !== undefined && !isSecret(value.apiKey))) {
      throw new Error('Provider account request is invalid');
    }
    const reference = credentialReference(account.id);
    const previous = account.authMode === 'local' ? undefined : await credentialSnapshot(reference);
    if (account.authMode !== 'local') {
      await storeCredential(account.provider, account.id, value.apiKey);
    }
    let replacement: PublicReplaceResult;
    try {
      replacement = await replace(transport, account);
    } catch (error) {
      if (error instanceof ProviderMutationReceiptUnavailableError) {
        if (account.authMode !== 'local') await restoreCredential(reference, previous);
        return { status: 'unavailable' as const };
      }
      throw error;
    }
    if ((replacement.outcome === 'rejected' || replacement.outcome === 'unavailable') && account.authMode !== 'local') {
      await restoreCredential(reference, previous);
    }
    return {
      status: replacement.outcome,
      ...(replacement.receipt ? { receipt: replacement.receipt } : {}),
    };
  });

  ipcMain.handle('providers:deleteAccount', async (_, input: unknown) => {
    const value = input as { accountId?: unknown; revision?: unknown };
    if (!isId(value.accountId) || !isRevision(value.revision)) {
      throw new Error('Provider account request is invalid');
    }
    try {
      const response = await transport.execute(accountRequest('providerAccounts.delete', {
        kind: 'delete', accountId: value.accountId, revision: value.revision,
      }));
      const outcome = mutationOutcomeForResponse(response, 'deleted');
      const receipt = mutationReceiptForResponse(response);
      return {
        status: outcome,
        ...(receipt ? { receipt } : {}),
      };
    } catch (error) {
      if (error instanceof ProviderMutationReceiptUnavailableError) {
        return { status: 'unavailable' as const };
      }
      throw error;
    }
  });

  ipcMain.handle('providers:startOAuth', async (_, input: unknown) => {
    const flow = parseFlow(input);
    if (!flow || !safeStorage.isEncryptionAvailable()) {
      throw new Error('Provider OAuth request is invalid');
    }
    activeFlows.set(flow.flowId, flow);
    publish(getMainWindow, { flowId: flow.flowId, status: 'started' });
    void runOAuth(flow, getMainWindow, transport);
    return { flowId: flow.flowId, status: 'started' as const };
  });

  ipcMain.handle('providers:submitOAuthCode', async (_, input: unknown) => {
    const value = input as { flowId?: unknown; code?: unknown };
    if (!isId(value.flowId) || !isSecret(value.code)) throw new Error('Provider OAuth request is invalid');
    const flow = activeFlows.get(value.flowId);
    if (!flow || flow.provider !== 'openai') throw new Error('Provider OAuth flow is unavailable');
    resolveManualCode(flow.flowId, value.code);
    return { flowId: flow.flowId, status: 'submitted' as const };
  });

  ipcMain.handle('providers:cancelOAuth', async (_, input: unknown) => {
    const flowId = (input as { flowId?: unknown })?.flowId;
    if (!isId(flowId)) throw new Error('Provider OAuth request is invalid');
    activeFlows.delete(flowId);
    rejectManualCode(flowId);
    publish(getMainWindow, { flowId, status: 'cancelled' });
    return { flowId, status: 'cancelled' as const };
  });
}

function sendPrivateResolverFailure(response: ServerResponse, code: PrivateResolverFailureCode, status = 503): void {
  response.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify({ error: code }));
}

export async function startProviderPrivateCredentialResolver(openClawStateDir: string): Promise<ProviderPrivateCredentialResolver> {
  const authorization = randomBytes(32).toString('base64url');
  const server = createServer(async (request, response) => {
    if ((request.method !== 'POST' && request.method !== 'DELETE' && request.method !== 'PUT')
      || request.url !== '/resolve'
      || !authorized(request.headers.authorization, authorization)) {
      response.writeHead(404).end();
      return;
    }
    const body = await readBoundedBody(request);
    const reference = body && isCredentialReference(body.reference) ? body.reference : undefined;
    const revision = body && isRevision(body.revision) ? body.revision : undefined;
    const profileProvider = body && isProfileProviderName(body.provider) ? body.provider : undefined;
    if (!reference || !isPrivateResolverRequest(request.method, body)) {
      sendPrivateResolverFailure(response, 'invalid-request', 400);
      return;
    }
    try {
      if (request.method === 'DELETE') {
        if (!revision || !profileProvider) {
          sendPrivateResolverFailure(response, 'invalid-request', 400);
          return;
        }
        await deletePrivateAccount(reference, profileProvider, openClawStateDir);
        response.writeHead(204).end();
      } else if (request.method === 'PUT') {
        if (!revision || !profileProvider) {
          sendPrivateResolverFailure(response, 'invalid-request', 400);
          return;
        }
        await removePrivateProfile(reference, profileProvider, openClawStateDir);
        await removeCredentialReference(reference);
        response.writeHead(204).end();
      } else if (!revision) {
        const value = await resolvePrivateCredential(reference);
        if (value === undefined) {
          response.writeHead(404).end();
          return;
        }
        response.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ value }));
      } else {
        if (!body) {
          sendPrivateResolverFailure(response, 'invalid-request', 400);
          return;
        }
        const provider = isProfileProviderName(body.provider) ? body.provider : undefined;
        const credentialProvider = isProviderName(body.credentialProvider) ? body.credentialProvider : undefined;
        const authMode = isAuthMode(body.authMode) ? body.authMode : undefined;
        if (!provider || !credentialProvider || !authMode || authMode === 'local') {
          sendPrivateResolverFailure(response, 'invalid-request', 400);
          return;
        }
        await applyPrivateProfile(reference, provider, credentialProvider, authMode, openClawStateDir);
        response.writeHead(204).end();
      }
    } catch (error) {
      sendPrivateResolverFailure(
        response,
        error instanceof ProviderPrivateResolverError ? error.code : 'unknown',
      );
    }
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject);
      resolve();
    });
  });
  const address = server.address();
  if (!address || typeof address === 'string') {
    await closeServer(server);
    throw new Error('Provider credential storage is unavailable');
  }
  return {
    endpoint: `http://127.0.0.1:${address.port}/resolve`,
    authorization,
    close: () => closeServer(server),
  };
}

async function runOAuth(
  flow: Flow,
  getMainWindow: () => BrowserWindow | null,
  transport: ProviderAccountsTransport,
): Promise<void> {
  let flowClaimed = false;
  try {
    const secret = flow.provider === 'openai'
      ? await openAiSecret(flow, getMainWindow)
      : await deviceSecret(flow, getMainWindow);
    if (!activeFlows.delete(flow.flowId)) return;
    flowClaimed = true;
    const reference = credentialReference(flow.account.id);
    const previous = await credentialSnapshot(reference);
    await storeSecret(flow.account.id, secret);
    const replacement = await replace(transport, flow.account);
    if (replacement.outcome === 'rejected') {
      await restoreCredential(reference, previous);
    }
    publish(getMainWindow, { flowId: flow.flowId, status: oauthOutcome(replacement.outcome) });
    if (replacement.outcome === 'stored') {
      publishLegacy(getMainWindow, 'oauth:success', {
        provider: flow.provider,
        accountId: replacement.accountId ?? flow.account.id,
        success: true,
      });
    } else {
      publishLegacy(getMainWindow, 'oauth:error', {
        message: oauthErrorMessage(replacement.outcome),
      });
    }
  } catch {
    if (flowClaimed || activeFlows.delete(flow.flowId)) {
      publish(getMainWindow, { flowId: flow.flowId, status: 'unknown' });
      publishLegacy(getMainWindow, 'oauth:error', { message: OAUTH_ERROR_MESSAGE });
    }
  } finally {
    rejectManualCode(flow.flowId);
  }
}

async function openAiSecret(flow: Flow, getMainWindow: () => BrowserWindow | null): Promise<unknown> {
  const token = await loginOpenAICodexOAuth({
    openUrl: async (url) => { await shell.openExternal(url); },
    onManualCodeRequired: ({ authorizationUrl, reason }) => {
      publish(getMainWindow, { flowId: flow.flowId, status: 'manual_code_required', authorizationUrl });
      publishLegacy(getMainWindow, 'oauth:code', {
        provider: flow.provider,
        mode: 'manual',
        authorizationUrl,
        message: manualCodeMessage(reason),
      });
    },
    onManualCodeInput: async () => await new Promise<string>((resolve, reject) => {
      manualCodes.set(flow.flowId, { resolve, reject });
    }),
  });
  return { kind: 'oauth', access: token.access, refresh: token.refresh, expires: token.expires, accountId: token.accountId };
}

async function deviceSecret(flow: Flow, getMainWindow: () => BrowserWindow | null): Promise<unknown> {
  const note = async (message: string) => {
    const verificationUri = message.match(/Open\s+(https?:\/\/\S+?)\s+to/i)?.[1];
    const userCode = verificationUri ? new URL(verificationUri).searchParams.get('user_code') : undefined;
    if (verificationUri && userCode) {
      publish(getMainWindow, { flowId: flow.flowId, status: 'device_code', verificationUri, userCode, expiresIn: 300 });
      publishLegacy(getMainWindow, 'oauth:code', {
        provider: flow.provider,
        verificationUri,
        userCode,
        expiresIn: 300,
      });
    }
  };
  const openUrl = async (url: string) => { await shell.openExternal(url); };
  const token = flow.provider === 'qwen-portal'
    ? await loginQwenPortalOAuth({ openUrl, note, progress: { update: () => {}, stop: () => {} } })
    : await loginMiniMaxPortalOAuth({
      region: flow.provider === 'minimax-portal-cn' ? 'cn' : 'global',
      openUrl,
      note,
      progress: { update: () => {}, stop: () => {} },
    });
  return { kind: 'oauth', access: token.access, refresh: token.refresh, expires: token.expires };
}

type PublicMutationOutcome = 'stored' | 'rejected' | 'unknown' | 'unavailable';
type PublicDeleteOutcome = 'deleted' | 'rejected' | 'unknown' | 'unavailable';
type PublicOAuthOutcome = 'completed' | 'rejected' | 'unknown' | 'unavailable';
type PublicReplaceResult = Readonly<{
  outcome: PublicMutationOutcome;
  accountId?: string;
  receipt?: ProviderMutationReceipt;
}>;

type ProviderMutationTransportResponse = Awaited<ReturnType<ProviderAccountsTransport['execute']>>;

async function replace(
  transport: ProviderAccountsTransport,
  account: AccountIntent,
): Promise<PublicReplaceResult> {
  const response = await transport.execute(accountRequest('providerAccounts.replace', {
    kind: 'replace',
    account,
  }));
  const outcome = mutationOutcomeForResponse(response, 'stored');
  const receipt = mutationReceiptForResponse(response);
  return {
    outcome,
    ...(outcome === 'stored' && hasAccountId(response.body) ? { accountId: response.body.account.id } : {}),
    ...(receipt ? { receipt } : {}),
  };
}

function mutationOutcomeForResponse(
  response: ProviderMutationTransportResponse,
  success: 'stored' | 'deleted',
): PublicMutationOutcome | PublicDeleteOutcome {
  if (response.status === 200 && isCommittedMutation(response.body, success)) return success;
  if (response.status === 422) return 'rejected';
  if (response.status === 409 && isUnknownMutation(response.body)) return 'unknown';
  return 'unavailable';
}

function mutationReceiptForResponse(response: ProviderMutationTransportResponse): ProviderMutationReceipt | undefined {
  if (response.status === 200 || response.status === 409) return receiptFromMutation(response.body);
  return undefined;
}

function isCommittedMutation(
  value: ProviderMutationTransportResponse['body'],
  desiredStatus: 'stored' | 'deleted',
): boolean {
  const receipt = receiptFromMutation(value);
  return isMutationReceipt(value)
    && value.success === true
    && receipt !== undefined
    && receipt.desired.status === desiredStatus
    && receipt.persisted.status === 'confirmed'
    && receipt.commit === 'committed';
}

function isUnknownMutation(value: ProviderMutationTransportResponse['body']): boolean {
  return isMutationReceipt(value)
    && value.success === false
    && value.code === 'commit-outcome-unknown'
    && value.error === MUTATION_UNKNOWN_ERROR
    && value.receipt.persisted.status === 'unknown'
    && value.receipt.commit === 'commit-outcome-unknown';
}

function isMutationReceipt(
  value: ProviderMutationTransportResponse['body'],
): value is ProviderMutationCommittedAccountResponse | ProviderMutationCommittedResponse | ProviderMutationCommitUnknownResponse {
  return value !== null
    && typeof value === 'object'
    && ('success' in value)
    && (value.success === true || value.success === false)
    && ('receipt' in value || ('desired' in value && 'persisted' in value && 'native' in value && 'commit' in value));
}

function receiptFromMutation(
  value: ProviderMutationTransportResponse['body'],
): ProviderMutationReceipt | undefined {
  if (!isMutationReceipt(value)) return undefined;
  if (value.success === false) return value.receipt;
  return {
    desired: value.desired,
    persisted: value.persisted,
    native: value.native,
    commit: value.commit,
  };
}

function oauthOutcome(outcome: PublicMutationOutcome): PublicOAuthOutcome {
  return outcome === 'stored' ? 'completed' : outcome;
}

function oauthErrorMessage(outcome: Exclude<PublicMutationOutcome, 'stored'>): string {
  switch (outcome) {
    case 'rejected':
      return 'Provider account request was rejected';
    case 'unknown':
      return 'Provider account is unknown';
    case 'unavailable':
      return 'Provider accounts are unavailable';
  }
}

function hasAccountId(
  value: Awaited<ReturnType<ProviderAccountsTransport['execute']>>['body'],
): value is Readonly<{ account: Readonly<{ id: string }> }> {
  return value !== null
    && typeof value === 'object'
    && 'account' in value
    && value.account !== null
    && typeof value.account === 'object'
    && 'id' in value.account
    && isId(value.account.id);
}

function accountRequest(operationId: 'providerAccounts.replace' | 'providerAccounts.delete', input: unknown): unknown {
  return {
    id: 'provider.accounts',
    operationId,
    scope: { kind: 'provider-account-catalog' },
    target: { kind: 'provider-accounts' },
    input,
  };
}

function publish(getMainWindow: () => BrowserWindow | null, payload: Record<string, unknown>): void {
  getMainWindow()?.webContents.send('host:event', { eventName: 'provider-oauth', payload });
}

function publishLegacy(
  getMainWindow: () => BrowserWindow | null,
  eventName: 'oauth:code' | 'oauth:success' | 'oauth:error',
  payload: Record<string, unknown>,
): void {
  getMainWindow()?.webContents.send('host:event', { eventName, payload });
}

function manualCodeMessage(reason: 'port_in_use' | 'callback_timeout'): string {
  return reason === 'port_in_use'
    ? 'OpenAI OAuth callback port 1455 is in use. Complete sign-in, then paste the final callback URL or code.'
    : 'OpenAI OAuth callback timed out. Paste the final callback URL or code to continue.';
}

function resolveManualCode(flowId: string, code: string): void {
  const pending = manualCodes.get(flowId);
  manualCodes.delete(flowId);
  pending?.resolve(code);
}

function rejectManualCode(flowId: string): void {
  const pending = manualCodes.get(flowId);
  manualCodes.delete(flowId);
  pending?.reject();
}

async function storeCredential(provider: string, accountId: string, apiKey: unknown): Promise<string> {
  const reference = credentialReference(accountId);
  const existing = (await readStore())[reference];
  if (apiKey === undefined && existing) return reference;
  if (!isSecret(apiKey)) throw new Error('A provider API key is required');
  return await storeSecret(accountId, { kind: 'apiKey', provider, key: apiKey });
}

async function credentialSnapshot(reference: string): Promise<string | undefined> {
  return (await readStore())[reference];
}

async function restoreCredential(reference: string, encrypted: string | undefined): Promise<void> {
  await updatePrivateStore((store) => {
    if (encrypted) store[reference] = encrypted;
    else delete store[reference];
  });
}

async function storeSecret(accountId: string, secret: unknown): Promise<string> {
  if (!safeStorage.isEncryptionAvailable()) throw new Error('Provider credential storage is unavailable');
  const serialized = JSON.stringify(secret);
  if (Buffer.byteLength(serialized) > MAX_SECRET_BYTES) throw new Error('Provider credential request is invalid');
  const reference = credentialReference(accountId);
  const encrypted = safeStorage.encryptString(serialized).toString('base64');
  await updatePrivateStore((store) => {
    store[reference] = encrypted;
  });
  return reference;
}

async function deletePrivateAccount(reference: string, profileProvider: string, openClawStateDir: string): Promise<void> {
  await removePrivateProfile(reference, profileProvider, openClawStateDir);
  await removeCredentialReference(reference);
}

async function readLegacyProviderStore(path: string): Promise<{
  accounts: Record<string, Record<string, unknown>>;
  apiKeys: Record<string, string>;
} | null> {
  try {
    const raw = await readFile(path, 'utf8');
    if (Buffer.byteLength(raw) > MAX_AUTH_PROFILES_BYTES) return null;
    const value: unknown = JSON.parse(raw);
    if (!isRecord(value) || value.schemaVersion !== 2) return null;
    return {
      accounts: Object.fromEntries(
        Object.entries(isRecord(value.accounts) ? value.accounts : {})
          .filter((entry): entry is [string, Record<string, unknown>] => isRecord(entry[1])),
      ),
      apiKeys: Object.fromEntries(
        Object.entries(isRecord(value.apiKeys) ? value.apiKeys : {})
          .filter((entry): entry is [string, string] => typeof entry[1] === 'string'),
      ),
    };
  } catch {
    return null;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

async function resolvePrivateCredential(reference: string): Promise<string | undefined> {
  const encrypted = (await readStore())[reference];
  if (!encrypted) return undefined;
  const credential = parsePrivateCredential(safeStorage.decryptString(Buffer.from(encrypted, 'base64')));
  if (credential.kind === 'apiKey') return credential.key;
  return credential.access;
}

async function applyPrivateProfile(
  reference: string,
  profileProvider: string,
  credentialProvider: string,
  authMode: Exclude<AuthMode, 'local'>,
  openClawStateDir: string,
): Promise<void> {
  const encrypted = await readPrivateCredential(reference);
  const credential = decryptPrivateCredential(encrypted);
  const profileId = privateProfileId(profileProvider);
  const legacyProfileId = legacyPrivateProfileId(reference);
  const profile = authMode === 'apiKey'
    ? credential.kind === 'apiKey' && credential.provider === credentialProvider
      ? { type: 'api_key', provider: profileProvider, key: credential.key }
      : undefined
    : credential.kind === 'oauth'
      ? oauthProfile(profileProvider, credential)
      : undefined;
  if (!profile) {
    throw new ProviderPrivateResolverError(
      credential.kind === 'apiKey' ? 'credential-provider-mismatch' : 'credential-invalid',
    );
  }

  await updateAuthProfileStore(openClawStateDir, (store) => {
    store.profiles[profileId] = profile;
    if (legacyProfileId !== profileId) {
      delete store.profiles[legacyProfileId];
      removeProfileReferences(store, legacyProfileId);
    }
    markProfileCurrent(store, profileProvider, profileId);
  });
}

function oauthProfile(
  provider: string,
  credential: Extract<ReturnType<typeof parsePrivateCredential>, { kind: 'oauth' }>,
): AuthProfile {
  const { kind: _, ...profile } = credential;
  return { ...profile, type: 'oauth', provider };
}

async function removePrivateProfile(reference: string, profileProvider: string, openClawStateDir: string): Promise<void> {
  const profileId = privateProfileId(profileProvider);
  const legacyProfileId = legacyPrivateProfileId(reference);
  await updateAuthProfileStore(openClawStateDir, (store) => {
    delete store.profiles[profileId];
    removeProfileReferences(store, profileId);
    if (legacyProfileId !== profileId) {
      delete store.profiles[legacyProfileId];
      removeProfileReferences(store, legacyProfileId);
    }
  });
}

function readPrivateCredential(reference: string): Promise<string> {
  return readStore().then((store) => {
    const encrypted = store[reference];
    if (!encrypted) throw new ProviderPrivateResolverError('credential-missing');
    return encrypted;
  }, (error) => {
    throw new ProviderPrivateResolverError('credential-store-unavailable', error);
  });
}

function decryptPrivateCredential(encrypted: string): ReturnType<typeof parsePrivateCredential> {
  try {
    return parsePrivateCredential(safeStorage.decryptString(Buffer.from(encrypted, 'base64')));
  } catch (error) {
    throw new ProviderPrivateResolverError('credential-decrypt-failed', error);
  }
}

function openClawProviderKey(provider: string, providerId: string, authMode?: AuthMode): string {
  if (provider === 'openai' && authMode === 'oauthBrowser') return 'openai';
  if (provider === 'minimax-portal-cn') return 'minimax-portal';
  if (provider === 'custom' || provider === 'ollama') return multiInstanceProviderKey(provider, providerId);
  return provider;
}

function multiInstanceProviderKey(provider: string, providerId: string): string {
  if (providerId === provider) return provider;
  const prefix = `${provider}-`;
  const suffixSource = providerId.startsWith(prefix) ? providerId.slice(prefix.length) : providerId;
  const suffix = normalizeProviderKeyPart(suffixSource);
  return `${provider}-${suffix.match(/^([A-Fa-f0-9]{8})-/)?.[1] ?? suffix}`;
}

function normalizeProviderKeyPart(value: string): string {
  return value.replace(/[^A-Za-z0-9._-]/g, '').replace(/-+/g, '-').replace(/^-+|-+$/g, '');
}

function privateProfileId(provider: string): string {
  return `${provider}:default`;
}

function legacyPrivateProfileId(reference: string): string {
  return reference.slice('credential:v1:'.length);
}

function markProfileCurrent(store: MutableAuthProfileStore, provider: string, profileId: string): void {
  store.order ??= {};
  store.order[provider] ??= [];
  if (!store.order[provider].includes(profileId)) {
    store.order[provider].push(profileId);
  }
  store.lastGood ??= {};
  store.lastGood[provider] = profileId;
}

function removeProfileReferences(store: MutableAuthProfileStore, profileId: string): void {
  if (store.order) {
    for (const [provider, profileIds] of Object.entries(store.order)) {
      const next = profileIds.filter((id) => id !== profileId);
      if (next.length > 0) {
        store.order[provider] = next;
      } else {
        delete store.order[provider];
      }
    }
  }
  if (store.lastGood) {
    for (const [provider, currentProfileId] of Object.entries(store.lastGood)) {
      if (currentProfileId === profileId) delete store.lastGood[provider];
    }
  }
}

function parsePrivateCredential(value: string):
  | Readonly<{ kind: 'apiKey'; provider: string; key: string }>
  | Readonly<{
    kind: 'oauth';
    access: string;
    refresh: string;
    expires: number;
    accountId?: string;
    clientId?: string;
    enterpriseUrl?: string;
    projectId?: string;
    chatgptPlanType?: string;
    idToken?: string;
    email?: string;
    displayName?: string;
  }> {
  const credential: unknown = JSON.parse(value);
  if (!credential || typeof credential !== 'object' || Array.isArray(credential)) {
    throw new Error('Provider credential is invalid');
  }
  const candidate = credential as Record<string, unknown>;
  if (candidate.kind === 'apiKey' && isProviderName(candidate.provider) && isSecret(candidate.key)) {
    return { kind: 'apiKey', provider: candidate.provider, key: candidate.key };
  }
  if (candidate.kind === 'oauth'
    && isSecret(candidate.access)
    && isSecret(candidate.refresh)
    && isRevision(candidate.expires)) {
    return {
      kind: 'oauth',
      access: candidate.access,
      refresh: candidate.refresh,
      expires: candidate.expires,
      ...optionalCredentialText(candidate, 'accountId'),
      ...optionalCredentialText(candidate, 'clientId'),
      ...optionalCredentialText(candidate, 'enterpriseUrl'),
      ...optionalCredentialText(candidate, 'projectId'),
      ...optionalCredentialText(candidate, 'chatgptPlanType'),
      ...optionalCredentialText(candidate, 'idToken'),
      ...optionalCredentialText(candidate, 'email'),
      ...optionalCredentialText(candidate, 'displayName'),
    };
  }
  throw new Error('Provider credential is invalid');
}

function optionalCredentialText(record: Record<string, unknown>, key: string): Record<string, string> {
  const value = record[key];
  return typeof value === 'string' ? { [key]: value } : {};
}

function authProfilesPath(openClawStateDir: string): string {
  return join(openClawStateDir, 'agents', 'main', 'agent', AUTH_PROFILES_FILE);
}

async function readAuthProfileStore(openClawStateDir: string): Promise<MutableAuthProfileStore> {
  try {
    const raw = await readFile(authProfilesPath(openClawStateDir), 'utf8');
    if (Buffer.byteLength(raw) > MAX_AUTH_PROFILES_BYTES) throw new Error();
    const value: unknown = JSON.parse(raw);
    if (!isAuthProfileStore(value)) throw new Error();
    return {
      ...value,
      version: 1,
      profiles: { ...value.profiles },
      order: value.order ? cloneAuthProfileOrder(value.order) : undefined,
      lastGood: value.lastGood ? { ...value.lastGood } : undefined,
    };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { version: 1, profiles: {} };
    throw new ProviderPrivateResolverError('auth-profile-read-invalid', error);
  }
}

function cloneAuthProfileOrder(order: AuthProfileOrder): AuthProfileOrder {
  return Object.fromEntries(Object.entries(order).map(([provider, profileIds]) => [provider, [...profileIds]]));
}

async function updateAuthProfileStore(
  openClawStateDir: string,
  mutate: (store: MutableAuthProfileStore) => void,
): Promise<void> {
  const previous = authProfileWrite;
  let release!: () => void;
  authProfileWrite = new Promise<void>((resolve) => { release = resolve; });
  await previous;
  try {
    const store = await readAuthProfileStore(openClawStateDir);
    mutate(store);
    await writeAuthProfileStore(openClawStateDir, store);
  } finally {
    release();
  }
}

async function writeAuthProfileStore(openClawStateDir: string, store: AuthProfileStore): Promise<void> {
  const path = authProfilesPath(openClawStateDir);
  const serialized = JSON.stringify(store);
  if (Buffer.byteLength(serialized) > MAX_AUTH_PROFILES_BYTES) {
    throw new ProviderPrivateResolverError('auth-profile-write-failed');
  }
  await replacePrivateFile(path, serialized).catch((error) => {
    throw new ProviderPrivateResolverError('auth-profile-write-failed', error);
  });
}

function isAuthProfileStore(value: unknown): value is AuthProfileStore {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const store = value as Record<string, unknown>;
  if (store.version !== 1 || !store.profiles || typeof store.profiles !== 'object' || Array.isArray(store.profiles)) {
    return false;
  }
  if (store.order !== undefined && !isAuthProfileOrder(store.order)) return false;
  if (store.lastGood !== undefined && !isAuthProfileLastGood(store.lastGood)) return false;
  return Object.entries(store.profiles).every(([id, profile]) => isId(id) && isAuthProfile(profile));
}

function isAuthProfileOrder(value: unknown): value is AuthProfileOrder {
  return !!value
    && typeof value === 'object'
    && !Array.isArray(value)
    && Object.entries(value).every(([provider, profileIds]) => isProfileProviderName(provider)
      && Array.isArray(profileIds)
      && profileIds.every(isId));
}

function isAuthProfileLastGood(value: unknown): value is AuthProfileLastGood {
  return !!value
    && typeof value === 'object'
    && !Array.isArray(value)
    && Object.entries(value).every(([provider, profileId]) => isProfileProviderName(provider) && isId(profileId));
}

function isAuthProfile(value: unknown): value is AuthProfile {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const profile = value as Record<string, unknown>;
  if (!isProfileProviderName(profile.provider)) return false;
  if (profile.type === 'api_key') {
    return hasOneSecret(profile.key, profile.keyRef)
      && Object.entries(profile).every(([key, profileValue]) => isCommonAuthProfileField(key, profileValue)
        || key === 'key' && isSecret(profileValue)
        || key === 'keyRef' && isSecretRef(profileValue));
  }
  if (profile.type === 'token') {
    return hasOneSecret(profile.token, profile.tokenRef)
      && Object.entries(profile).every(([key, profileValue]) => isCommonAuthProfileField(key, profileValue)
        || key === 'token' && isSecret(profileValue)
        || key === 'tokenRef' && isSecretRef(profileValue)
        || key === 'expires' && isRevision(profileValue));
  }
  if (profile.type !== 'oauth'
    || !isSecret(profile.access)
    || !isSecret(profile.refresh)
    || !isRevision(profile.expires)) {
    return false;
  }
  return Object.entries(profile).every(([key, profileValue]) => isCommonAuthProfileField(key, profileValue)
    || ['access', 'refresh'].includes(key) && isSecret(profileValue)
    || key === 'expires' && isRevision(profileValue)
    || ['clientId', 'enterpriseUrl', 'projectId', 'accountId', 'chatgptPlanType', 'idToken'].includes(key) && typeof profileValue === 'string');
}

function isSecretInput(value: unknown): value is SecretInput {
  return isSecret(value) || isSecretRef(value);
}

function isSecretRef(value: unknown): value is SecretRef {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const ref = value as Record<string, unknown>;
  return (ref.source === 'env' || ref.source === 'file' || ref.source === 'exec')
    && isProfileProviderName(ref.provider)
    && isSecret(ref.id);
}

function hasOneSecret(left: unknown, right: unknown): boolean {
  return (isSecret(left) && right === undefined) || (left === undefined && isSecretRef(right));
}

function isCommonAuthProfileField(key: string, value: unknown): boolean {
  if (key === 'type') return value === 'api_key' || value === 'token' || value === 'oauth';
  if (key === 'provider') return isProfileProviderName(value);
  if (key === 'copyToAgents') return typeof value === 'boolean';
  if (key === 'email' || key === 'displayName') return typeof value === 'string';
  if (key === 'metadata') return isStringRecord(value);
  return false;
}

function isStringRecord(value: unknown): value is Record<string, string> {
  return !!value
    && typeof value === 'object'
    && !Array.isArray(value)
    && Object.values(value).every((entry) => typeof entry === 'string');
}

async function removeCredentialReference(reference: string): Promise<void> {
  await updatePrivateStore((store) => {
    delete store[reference];
  });
}

function parseFlow(input: unknown): Flow | null {
  const value = input as { flowId?: unknown; account?: unknown; provider?: unknown };
  const account = parseAccount(value?.account);
  return isId(value?.flowId) && account && isProvider(value.provider)
    && account.provider === value.provider
    && ((value.provider === 'openai' && account.authMode === 'oauthBrowser')
      || (value.provider !== 'openai' && account.authMode === 'oauthDevice'))
    ? { flowId: value.flowId, account, provider: value.provider }
    : null;
}

function parseAccount(value: unknown): AccountIntent | null {
  const account = value as Partial<AccountIntent>;
  const kind = account?.kind ?? 'chat';
  if (!isId(account?.id)
    || !isProviderName(account.provider)
    || !isText(account.label)
    || typeof account.enabled !== 'boolean'
    || !isAccountKind(kind)
    || !optionalAccountText(account.endpoint, 2048)
    || !isAccountProtocols(kind, account.protocol, account.mediaProtocol)
    || !isAuthMode(account.authMode)
    || !isRevision(account.revision)) {
    return null;
  }
  return {
    id: account.id,
    provider: account.provider,
    label: account.label,
    enabled: account.enabled,
    kind,
    ...(account.endpoint === undefined ? {} : { endpoint: account.endpoint }),
    ...(account.protocol === undefined ? {} : { protocol: account.protocol }),
    ...(account.mediaProtocol === undefined ? {} : { mediaProtocol: account.mediaProtocol }),
    authMode: account.authMode,
    revision: account.revision,
  };
}

function isAccountKind(value: unknown): value is AccountKind {
  return value === 'chat' || value === 'media';
}

function isAccountProtocols(
  kind: AccountKind,
  protocol: unknown,
  mediaProtocol: unknown,
): protocol is ApiProtocol | undefined {
  if (kind === 'media') return protocol === undefined && isMediaProtocol(mediaProtocol);
  return mediaProtocol === undefined && (protocol === undefined || isApiProtocol(protocol));
}

function isApiProtocol(value: unknown): value is ApiProtocol {
  return value === 'anthropicMessages'
    || value === 'googleGenerativeAi'
    || value === 'openAiCompletions'
    || value === 'openAiResponses';
}

function isMediaProtocol(value: unknown): value is MediaProtocol {
  return value === 'google' || value === 'openAi' || value === 'openRouter';
}

function optionalAccountText(value: unknown, maxLength: number): value is string | undefined {
  return value === undefined || (typeof value === 'string'
    && value.trim().length > 0
    && value.length <= maxLength
    && !/[\0\r\n]/.test(value));
}

function credentialReference(accountId: string): string {
  return `credential:v1:${accountId}`;
}

function isProvider(value: unknown): value is Provider {
  return value === 'openai' || value === 'minimax-portal' || value === 'minimax-portal-cn' || value === 'qwen-portal';
}

function isProfileProviderName(value: unknown): value is string {
  return typeof value === 'string' && value.length <= MAX_PROVIDER_KEY_BYTES && /^[A-Za-z0-9_.-]+$/.test(value);
}

function isProviderName(value: unknown): value is string {
  return typeof value === 'string' && /^[A-Za-z0-9_.-]{1,128}$/.test(value);
}

function isAuthMode(value: unknown): value is AuthMode {
  return value === 'apiKey' || value === 'oauthBrowser' || value === 'oauthDevice' || value === 'local';
}

function isRevision(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
}

function isId(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= MAX_ID_BYTES && /^[A-Za-z0-9_.:-]+$/.test(value);
}

function isText(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0 && value.length <= 256 && !/[\0\r\n]/.test(value);
}

function isSecret(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0 && Buffer.byteLength(value) <= MAX_SECRET_BYTES && !value.includes('\0');
}

function isCredentialReference(value: unknown): value is string {
  return typeof value === 'string' && /^credential:v1:[A-Za-z0-9_.:-]{1,128}$/.test(value);
}

function isPrivateResolverRequest(
  method: string,
  body: Record<string, unknown> | undefined,
): boolean {
  if (!body) return false;
  const keys = Object.keys(body).sort();
  if (method === 'POST') {
    return keys.join(',') === 'reference'
      || keys.join(',') === 'authMode,credentialProvider,provider,reference,revision';
  }
  return keys.join(',') === 'provider,reference,revision';
}

function authorized(value: string | undefined, expected: string): boolean {
  if (!value?.startsWith('Bearer ')) return false;
  const actual = Buffer.from(value.slice('Bearer '.length));
  const expectedBytes = Buffer.from(expected);
  return actual.length === expectedBytes.length && timingSafeEqual(actual, expectedBytes);
}

async function readBoundedBody(request: NodeJS.ReadableStream): Promise<Record<string, unknown> | undefined> {
  const chunks: Buffer[] = [];
  let length = 0;
  for await (const chunk of request) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    length += bytes.length;
    if (length > MAX_PRIVATE_REQUEST_BYTES) return undefined;
    chunks.push(bytes);
  }
  try {
    const value: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    return value && typeof value === 'object' && !Array.isArray(value)
      ? value as Record<string, unknown>
      : undefined;
  } catch {
    return undefined;
  }
}

async function closeServer(server: Server): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
  });
}

function storePath(): string { return join(app.getPath('userData'), STORE_FILE); }

async function readStore(): Promise<PrivateStore> {
  try {
    const raw = await readFile(storePath(), 'utf8');
    const value: unknown = JSON.parse(raw);
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error();
    return Object.fromEntries(Object.entries(value).filter(([key, encrypted]) => isCredentialReference(key) && typeof encrypted === 'string'));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return {};
    throw new Error('Provider credential storage is unavailable', { cause: error });
  }
}

async function updatePrivateStore(mutate: (store: PrivateStore) => void): Promise<void> {
  const previous = privateStoreWrite;
  let release!: () => void;
  privateStoreWrite = new Promise<void>((resolve) => { release = resolve; });
  await previous;
  try {
    const store = await readStore();
    mutate(store);
    await replacePrivateFile(storePath(), JSON.stringify(store));
  } finally {
    release();
  }
}

async function replacePrivateFile(path: string, contents: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    const file = await open(temporary, 'w', 0o600);
    try {
      await file.writeFile(contents, { encoding: 'utf8' });
      await file.sync();
    } finally {
      await file.close();
    }
    await rename(temporary, path);
    await syncContainingDirectory(path);
  } catch (error) {
    await rm(temporary, { force: true });
    throw error;
  }
}

async function syncContainingDirectory(path: string): Promise<void> {
  if (platform === 'win32') return;
  const directory = await open(dirname(path), 'r');
  try {
    await directory.sync();
  } finally {
    await directory.close();
  }
}
