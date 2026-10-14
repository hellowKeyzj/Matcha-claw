import { traceDebug, isTraceEnabled } from '../../utils/trace-logger';
import { summarizeIdentifier } from '../runtime-host-delivery/transport/sessions/trace';
import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { mkdir, open, readFile, rename, rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { platform } from 'node:process';
import { app, BrowserWindow, ipcMain, safeStorage, shell } from 'electron';

import type { ProviderAccountsTransport } from '../runtime-host-delivery/transport/providers/accounts';
import type { CallReceipt, CallRecord } from '../../../src/types/call-log';
import type { ProviderCallDetail } from '../../../src/types/call-log/provider';
import { decodeCallReceipt } from '../../../src/types/call-log/receipt';
import { probeAnthropicCliAuth } from './provider-private-auth/anthropic-cli-probe';
import { AuthProfileSqliteError, AuthProfileSqliteWriter } from './provider-private-auth/auth-profile-sqlite';
import {
  beginPrivateAccountTransaction, claimPrivateAccountTransaction, closePrivateAccountTransactions,
  privateAccountTransactionForRequest, settlePrivateAccountTransaction,
  type PrivateAccountTransaction,
} from './provider-private-auth/account-transactions';
import { loginOpenAICodexOAuth } from '../../services/providers/oauth/openai-codex-oauth';
import { loginOpenAIDeviceOAuth } from '../../services/providers/oauth/openai-device-oauth';
import { loginGitHubCopilotDeviceOAuth } from '../../services/providers/oauth/github-copilot-device-oauth';
import { loginOpenRouterOAuth } from '../../services/providers/oauth/openrouter-oauth';
import {
  loginMiniMaxPortalOAuth,
  loginQwenPortalOAuth,
} from '../../services/providers/oauth/device-oauth-providers';

const STORE_FILE = 'provider-private-auth.v1.json';
const MAX_SECRET_BYTES = 16 * 1024;
const MAX_ID_BYTES = 128;
const MAX_PRIVATE_REQUEST_BYTES = 1024;
const MAX_PRIVATE_RESOLVER_REQUESTS = 64;
const MAX_AUTH_PROFILES_BYTES = 1024 * 1024;
const MAX_PROVIDER_KEY_BYTES = 256;
const OAUTH_ERROR_MESSAGE = 'Provider OAuth authentication failed';

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

type Provider = 'openai' | 'openrouter' | 'github-copilot' | 'minimax-portal' | 'minimax-portal-cn' | 'qwen-portal';
type AuthMode = 'apiKey' | 'oauthBrowser' | 'oauthDevice' | 'local' | 'token' | 'cliReuse';
type CredentialAuthMode = Exclude<AuthMode, 'local' | 'cliReuse'>;
type AccountKind = 'chat' | 'media';
type ApiProtocol = 'anthropicMessages' | 'googleGenerativeAi' | 'openAiCompletions' | 'openAiResponses';
type MediaProtocol = 'google' | 'openAi' | 'openRouter';
type PrivateStore = Record<string, string>;
type AuthProfile = Record<string, unknown>;
export type ProviderAccountIntent = Readonly<{
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
type AccountIntent = ProviderAccountIntent;
type Flow = Readonly<{ flowId: string; account: AccountIntent; provider: Provider; controller: AbortController }>;

export type AwaitProviderCall = (receipt: CallReceipt, command: 'providerAccounts.replace' | 'providerAccounts.delete') => Promise<CallRecord<'provider'>>;
export type ProviderPrivateAccountDependencies = Readonly<{ transport: ProviderAccountsTransport; awaitProviderCall: AwaitProviderCall }>;

const activeFlows = new Map<string, Flow>();
const manualCodes = new Map<string, { resolve: (value: string) => void; reject: () => void }>();
let privateStoreWrite = Promise.resolve();

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
  let authProfiles: AuthProfileSqliteWriter;
  try { authProfiles = await AuthProfileSqliteWriter.start(openClawStateDir); }
  catch { return; }
  try {
    for (const [accountId, account] of Object.entries(legacy.accounts)) {
      const provider = storedAccountProvider(account);
      const authMode = storedAccountAuthMode(account);
      if (!isId(accountId) || !provider || !authMode || authMode === 'local' || authMode === 'cliReuse') continue;
      const reference = credentialReference(accountId);
      const existing = await credentialSnapshot(reference);
      const key = legacy.apiKeys[accountId];
      if (!existing && (authMode !== 'apiKey' || !isSecret(key))) continue;
      try {
        if (!existing) await storeSecret(accountId, { kind: 'apiKey', provider, key });
        await applyPrivateProfile(reference, openClawProviderKey(provider, accountId, authMode), provider, authMode, authProfiles);
      } catch {
        if (!existing) await removeCredentialReference(reference).catch(() => undefined);
      }
    }
  } finally {
    await authProfiles.close().catch(() => undefined);
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
  awaitProviderCall: AwaitProviderCall,
): void {
  ipcMain.handle('providers:storeAccount', async (_, input: unknown) => {
    const value = input as { account?: unknown; apiKey?: unknown; token?: unknown };
    providerPrivateAuthTrace('ipc.store.received', () => ({
      hasAccount: Boolean(value?.account),
      privateAuthInputPresent: (typeof value?.apiKey === 'string' && value.apiKey.trim().length > 0)
        || (typeof value?.token === 'string' && value.token.trim().length > 0),
    }));
    const account = parseAccount(value?.account);
    if (!account
      || value.apiKey !== undefined && (account.authMode !== 'apiKey' || !isSecret(value.apiKey))
      || value.token !== undefined && (account.authMode !== 'token' || !isSecret(value.token))) {
      providerPrivateAuthTrace('ipc.store.rejected', () => ({ detail: 'invalid-account' }));
      return { status: 'rejected', reason: 'invalid-request' } satisfies PrivateAccountAdmissionFailure;
    }
    providerPrivateAuthTrace('ipc.store.decoded', () => (accountTrace(account)));
    try {
      return await admitPrivateAccount(transport, await preparePrivateAccount(account, value.apiKey, value.token), account);
    } catch {
      return { status: 'unknown', reason: 'outcome-unknown' } satisfies PrivateAccountAdmissionFailure;
    }
  });

  ipcMain.handle('providers:deleteAccount', async (_, input: unknown) => {
    const value = input as { accountId?: unknown; revision?: unknown };
    providerPrivateAuthTrace('ipc.delete.received', () => ({
      accountId: idShape(typeof value?.accountId === 'string' ? value.accountId : undefined),
      revision: typeof value?.revision === 'number' ? value.revision : undefined,
    }));
    if (!isId(value?.accountId) || !isRevision(value?.revision)) {
      providerPrivateAuthTrace('ipc.delete.rejected', () => ({ detail: 'invalid-request' }));
      return { status: 'rejected', reason: 'invalid-request' } satisfies PrivateAccountAdmissionFailure;
    }
    try {
      return await admitPrivateDelete(transport, value.accountId, value.revision);
    } catch {
      return { status: 'unknown', reason: 'outcome-unknown' } satisfies PrivateAccountAdmissionFailure;
    }
  });

  ipcMain.handle('providers:startOAuth', async (_, input: unknown) => {
    const flow = parseFlow(input);
    if (!flow || !safeStorage.isEncryptionAvailable()) {
      throw new Error('Provider OAuth request is invalid');
    }
    if (activeFlows.has(flow.flowId)) throw new Error('Provider OAuth flow is already active');
    activeFlows.set(flow.flowId, flow);
    publish(getMainWindow, { flowId: flow.flowId, status: 'started' });
    void runOAuth(flow, getMainWindow, { transport, awaitProviderCall });
    return { flowId: flow.flowId, status: 'started' as const };
  });

  ipcMain.handle('providers:submitOAuthCode', async (_, input: unknown) => {
    const value = input as { flowId?: unknown; code?: unknown };
    if (!isId(value.flowId) || !isSecret(value.code)) throw new Error('Provider OAuth request is invalid');
    const flow = activeFlows.get(value.flowId);
    if (!flow || flow.provider !== 'openai' || flow.account.authMode !== 'oauthBrowser') {
      throw new Error('Provider OAuth flow is unavailable');
    }
    resolveManualCode(flow.flowId, value.code);
    return { flowId: flow.flowId, status: 'submitted' as const };
  });

  ipcMain.handle('providers:cancelOAuth', async (_, input: unknown) => {
    const flowId = (input as { flowId?: unknown })?.flowId;
    if (!isId(flowId)) throw new Error('Provider OAuth request is invalid');
    activeFlows.get(flowId)?.controller.abort();
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
  const authProfiles = await AuthProfileSqliteWriter.start(openClawStateDir);
  const authorization = randomBytes(32).toString('base64url');
  const requests = new Set<Promise<void>>();
  let closing: Promise<void> | undefined;
  const handleRequest = async (request: IncomingMessage, response: ServerResponse): Promise<void> => {
    if ((request.method !== 'POST' && request.method !== 'DELETE' && request.method !== 'PUT')
      || request.url !== '/resolve'
      || !authorized(request.headers.authorization, authorization)) {
      if (request.method === 'POST') {
        traceDebug(() => JSON.stringify({
          prefix: 'session-trace', source: 'electron-main',
          stage: 'electron.private-credential.resolve.result', at: Date.now(),
          outcome: 'route-rejected', status: 404,
        }));
      }
      response.writeHead(404).end();
      return;
    }
    const body = await readBoundedBody(request);
    const reference = body && isCredentialReference(body.reference) ? body.reference : undefined;
    const revision = body && isRevision(body.revision) ? body.revision : undefined;
    const profileProvider = body && isProfileProviderName(body.provider) ? body.provider : undefined;
    const resolving = isTraceEnabled() && request.method === 'POST'
      && (!body || !Object.hasOwn(body, 'revision') && !Object.hasOwn(body, 'operation'));
    const started = resolving ? performance.now() : undefined;
    const traceResolve = (stage: string, payload: () => Record<string, unknown>): void => {
      if (!resolving) return;
      traceDebug(() => JSON.stringify({
        prefix: 'session-trace', source: 'electron-main', stage, at: Date.now(),
        referenceHash: summarizeIdentifier(reference).hash,
        referencePresent: body?.reference !== undefined,
        referenceValid: reference !== undefined,
        elapsedMs: started === undefined ? undefined : performance.now() - started,
        ...payload(),
      }));
    };
    traceResolve('electron.private-credential.resolve.request', () => ({}));
    if (!reference || !isPrivateResolverRequest(request.method, body)) {
      traceResolve('electron.private-credential.resolve.result', () => ({
        outcome: 'invalid-input', code: 'invalid-request', status: 400,
      }));
      sendPrivateResolverFailure(response, 'invalid-request', 400);
      return;
    }
    try {
      if (body?.operation === 'claim' || body?.operation === 'settle') {
        const transaction = privateAccountTransactionForRequest(body.transactionId as string, reference, revision!);
        if (!transaction) throw new ProviderPrivateResolverError('invalid-request');
        if (body.operation === 'claim') {
          if (!claimPrivateAccountTransaction(transaction)) throw new ProviderPrivateResolverError('invalid-request');
        } else {
          await settlePrivateAccountTransaction(transaction, body.settlement as 'retained' | 'rejected' | 'unknown', restoreCredential);
        }
        response.writeHead(204).end();
      } else if (request.method === 'DELETE') {
        if (!revision || !profileProvider) {
          sendPrivateResolverFailure(response, 'invalid-request', 400);
          return;
        }
        await deletePrivateAccount(reference, profileProvider, authProfiles);
        response.writeHead(204).end();
      } else if (request.method === 'PUT') {
        if (!revision || !profileProvider) {
          sendPrivateResolverFailure(response, 'invalid-request', 400);
          return;
        }
        await removePrivateProfile(reference, profileProvider, authProfiles);
        await removeCredentialReference(reference);
        response.writeHead(204).end();
      } else if (!revision) {
        traceResolve('electron.private-credential.resolve.branch', () => ({ outcome: 'lookup' }));
        const value = await resolvePrivateCredential(reference);
        if (value === undefined) {
          traceResolve('electron.private-credential.resolve.result', () => ({ outcome: 'not-found', status: 404 }));
          response.writeHead(404).end();
          return;
        }
        traceResolve('electron.private-credential.resolve.result', () => ({ outcome: 'resolved', status: 200 }));
        response.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ value }));
      } else {
        if (!body) {
          sendPrivateResolverFailure(response, 'invalid-request', 400);
          return;
        }
        const provider = isProfileProviderName(body.provider) ? body.provider : undefined;
        const credentialProvider = isProviderName(body.credentialProvider) ? body.credentialProvider : undefined;
        const authMode = isAuthMode(body.authMode) ? body.authMode : undefined;
        if (!provider || !credentialProvider || !authMode || authMode === 'local' || authMode === 'cliReuse') {
          sendPrivateResolverFailure(response, 'invalid-request', 400);
          return;
        }
        await applyPrivateProfile(reference, provider, credentialProvider, authMode, authProfiles);
        response.writeHead(204).end();
      }
    } catch (error) {
      traceResolve('electron.private-credential.resolve.result', () => ({
        outcome: 'private-error', status: 503,
        code: (error instanceof ProviderPrivateResolverError || error instanceof AuthProfileSqliteError) && [
          'invalid-request', 'credential-missing', 'credential-decrypt-failed',
          'credential-provider-mismatch', 'credential-invalid', 'auth-profile-read-invalid',
          'auth-profile-write-failed', 'credential-store-unavailable', 'unknown',
        ].includes(error.code) ? error.code : 'unknown',
      }));
      sendPrivateResolverFailure(
        response,
        error instanceof ProviderPrivateResolverError || error instanceof AuthProfileSqliteError ? error.code : 'unknown',
      );
    }
  };
  const server = createServer((request, response) => {
    if (closing || requests.size >= MAX_PRIVATE_RESOLVER_REQUESTS) {
      sendPrivateResolverFailure(response, 'auth-profile-write-failed');
      request.resume();
      return;
    }
    // A disconnected observer does not cancel an admitted SQLite side effect.
    const pending = handleRequest(request, response).catch(() => {
      if (!response.headersSent) sendPrivateResolverFailure(response, 'unknown');
    });
    requests.add(pending);
    void pending.then(() => { requests.delete(pending); });
  });
  try {
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', () => {
        server.off('error', reject);
        resolve();
      });
    });
  } catch (error) {
    await authProfiles.close().catch(() => undefined);
    throw error;
  }
  const address = server.address();
  if (!address || typeof address === 'string') {
    try { await closeServer(server); } finally { await authProfiles.close(); }
    throw new Error('Provider credential storage is unavailable');
  }
  return {
    endpoint: `http://127.0.0.1:${address.port}/resolve`,
    authorization,
    close: () => {
      closing ??= (async () => {
        try {
          await closeServer(server);
          await Promise.all(requests);
          await privateStoreWrite;
          await closePrivateAccountTransactions(restoreCredential);
        } finally {
          await authProfiles.close();
        }
      })();
      return closing;
    },
  };
}

async function runOAuth(
  flow: Flow,
  getMainWindow: () => BrowserWindow | null,
  deps: ProviderPrivateAccountDependencies,
): Promise<void> {
  let flowClaimed = false;
  try {
    const secret = await loginFlow(flow, getMainWindow);
    if (flow.controller.signal.aborted || activeFlows.get(flow.flowId) !== flow) return;
    activeFlows.delete(flow.flowId);
    flowClaimed = true;
    const account = {
      ...flow.account,
      authMode: secret.kind === 'apiKey' ? 'apiKey' as const
        : secret.kind === 'token' ? 'token' as const : flow.account.authMode,
    };
    const replacement = await commitPrivateAccount(deps, account, secret);
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
    if (flowClaimed || activeFlows.get(flow.flowId) === flow) {
      if (activeFlows.get(flow.flowId) === flow) activeFlows.delete(flow.flowId);
      publish(getMainWindow, { flowId: flow.flowId, status: 'unknown' });
      publishLegacy(getMainWindow, 'oauth:error', { message: OAUTH_ERROR_MESSAGE });
    }
  } finally {
    if (!activeFlows.has(flow.flowId)) rejectManualCode(flow.flowId);
  }
}

type PrivateCredential = ReturnType<typeof parsePrivateCredential>;

async function loginFlow(flow: Flow, getMainWindow: () => BrowserWindow | null): Promise<PrivateCredential> {
  const signal = flow.controller.signal;
  const openUrl = async (url: string) => {
    signal.throwIfAborted();
    await shell.openExternal(url);
  };
  const onVerification = (info: { verificationUri: string; userCode: string; expiresIn: number }) => {
    if (signal.aborted) return;
    publish(getMainWindow, { flowId: flow.flowId, status: 'device_code', ...info });
    publishLegacy(getMainWindow, 'oauth:code', { provider: flow.provider, ...info });
  };
  if (flow.provider === 'openrouter') {
    const { key } = await loginOpenRouterOAuth({ openUrl, signal });
    return { kind: 'apiKey', provider: flow.provider, key };
  }
  if (flow.provider === 'github-copilot') {
    const { token } = await loginGitHubCopilotDeviceOAuth({ openUrl, onVerification, signal });
    return { kind: 'token', provider: flow.provider, token };
  }
  if (flow.provider === 'openai') {
    if (flow.account.authMode === 'oauthBrowser') return await openAiSecret(flow, getMainWindow);
    const token = await loginOpenAIDeviceOAuth({ openUrl, onVerification, signal });
    return { kind: 'oauth', ...token };
  }
  return await deviceSecret(flow, getMainWindow);
}

async function openAiSecret(flow: Flow, getMainWindow: () => BrowserWindow | null): Promise<PrivateCredential> {
  const signal = flow.controller.signal;
  const token = await loginOpenAICodexOAuth({
    signal,
    openUrl: async (url) => { signal.throwIfAborted(); await shell.openExternal(url); },
    onManualCodeRequired: ({ authorizationUrl, reason }) => {
      if (signal.aborted || activeFlows.get(flow.flowId) !== flow) return;
      publish(getMainWindow, { flowId: flow.flowId, status: 'manual_code_required', authorizationUrl });
      publishLegacy(getMainWindow, 'oauth:code', {
        provider: flow.provider,
        mode: 'manual',
        authorizationUrl,
        message: manualCodeMessage(reason),
      });
    },
    onManualCodeInput: async () => await new Promise<string>((resolve, reject) => {
      signal.throwIfAborted();
      const cleanup = () => {
        if (manualCodes.get(flow.flowId) === pending) manualCodes.delete(flow.flowId);
        signal.removeEventListener('abort', pending.reject);
      };
      const pending = {
        resolve: (value: string) => { cleanup(); resolve(value); },
        reject: () => { cleanup(); reject(signal.reason); },
      };
      manualCodes.set(flow.flowId, pending);
      signal.addEventListener('abort', pending.reject, { once: true });
    }),
  });
  return { kind: 'oauth', access: token.access, refresh: token.refresh, expires: token.expires, accountId: token.accountId };
}

async function deviceSecret(flow: Flow, getMainWindow: () => BrowserWindow | null): Promise<PrivateCredential> {
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
  detail?: ProviderCallDetail;
}>;

export type ProviderPrivateAccountMutationResult = Readonly<{
  status: PublicMutationOutcome | PublicDeleteOutcome;
  detail?: ProviderCallDetail;
  reason?: 'invalid-request' | 'rejected' | 'not-admitted' | 'outcome-unknown';
}>;

type PrivateAccountAdmissionFailure = ProviderPrivateAccountMutationResult & (
  | Readonly<{ status: 'rejected'; reason: 'invalid-request' | 'rejected' | 'not-admitted' }>
  | Readonly<{ status: 'unknown'; reason: 'outcome-unknown' }>
);
type PrivateAccountAdmissionResult = CallReceipt | PrivateAccountAdmissionFailure;

type ProviderMutationTransportResponse = Awaited<ReturnType<ProviderAccountsTransport['execute']>>;

function providerPrivateAuthTrace(phase: string, payload: () => Record<string, unknown> = () => ({})): void {
  traceDebug(() => JSON.stringify({
    prefix: '[startup-trace]',
    source: 'provider-private-auth',
    phase,
    at: Date.now(),
    ...payload(),
  }));
}

function idShape(value: string | null | undefined): { present: boolean; length: number } {
  return value ? { present: true, length: value.length } : { present: false, length: 0 };
}

function accountTrace(account: AccountIntent): Record<string, unknown> {
  return {
    accountId: idShape(account.id),
    provider: account.provider,
    authMode: account.authMode,
    kind: account.kind,
    enabled: account.enabled,
    revision: account.revision,
    endpoint: idShape(account.endpoint),
    protocol: account.protocol,
    mediaProtocol: account.mediaProtocol,
  };
}

function detailTrace(detail: ProviderCallDetail | undefined): Record<string, unknown> {
  return detail ? { persisted: detail.persisted, commit: detail.commit, native: detail.native, diagnostic: detail.diagnostic } : {};
}

export async function storeProviderPrivateAccount(
  deps: ProviderPrivateAccountDependencies,
  account: ProviderAccountIntent,
  apiKey?: unknown,
  token?: unknown,
): Promise<ProviderPrivateAccountMutationResult> {
  const transaction = await preparePrivateAccount(account, apiKey, token);
  const receipt = await admitPrivateAccount(deps.transport, transaction, account);
  return 'status' in receipt ? receipt
    : await accountCallResult(deps, receipt, 'providerAccounts.replace', account.id, account.revision);
}

async function preparePrivateAccount(
  account: AccountIntent, apiKey?: unknown, token?: unknown,
): Promise<PrivateAccountTransaction> {
  if (!parseAccount(account)
    || apiKey !== undefined && (account.authMode !== 'apiKey' || !isSecret(apiKey))
    || token !== undefined && (account.authMode !== 'token' || !isSecret(token))) {
    throw new Error('Provider account request is invalid');
  }
  if (account.authMode === 'cliReuse' && account.enabled) {
    const status = await probeAnthropicCliAuth();
    if (status !== 'available') {
      throw new Error(status === 'missing'
        ? 'Claude CLI is not authenticated. Run claude auth login, then retry.'
        : 'Claude CLI authentication could not be verified. Run claude auth status, then retry.');
    }
  }
  const secret: PrivateCredential | undefined = apiKey !== undefined
    ? { kind: 'apiKey', provider: account.provider, key: apiKey as string }
    : token !== undefined
      ? { kind: 'token', provider: account.provider, token: normalizeProviderToken(account.provider, token as string) }
      : undefined;
  return preparePrivateAccountSecret(account, secret);
}

async function preparePrivateAccountSecret(
  account: AccountIntent, secret?: PrivateCredential,
): Promise<PrivateAccountTransaction> {
  const reference = credentialReference(account.id);
  const transaction = await beginPrivateAccountTransaction(reference, account.revision, () => credentialSnapshot(reference), restoreCredential);
  try {
    if (account.authMode !== 'local' && account.authMode !== 'cliReuse') {
      if (secret) await storeSecret(account.id, secret);
      else if (!transaction.previous) throw new Error('A provider credential is required');
    }
    return transaction;
  } catch (error) {
    await settlePrivateAccountTransaction(transaction, 'rejected', restoreCredential);
    throw error;
  }
}

async function commitPrivateAccount(
  deps: ProviderPrivateAccountDependencies,
  account: AccountIntent,
  secret?: PrivateCredential,
): Promise<PublicReplaceResult> {
  const transaction = await preparePrivateAccountSecret(account, secret);
  const receipt = await admitPrivateAccount(deps.transport, transaction, account);
  if ('status' in receipt) return { outcome: receipt.status };
  const result = await accountCallResult(deps, receipt, 'providerAccounts.replace', account.id, account.revision);
  return { outcome: result.status as PublicMutationOutcome, accountId: account.id, detail: result.detail };
}

function normalizeProviderToken(provider: string, token: string): string {
  if (provider !== 'anthropic') return token;
  const normalized = token.replace(/\s+/g, '');
  if (!normalized.startsWith('sk-ant-oat01-') || normalized.length < 80) {
    throw new Error('Paste the full Anthropic setup-token starting with sk-ant-oat01-.');
  }
  return normalized;
}

export async function deleteProviderPrivateAccount(
  deps: ProviderPrivateAccountDependencies,
  accountId: string,
  revision: number,
): Promise<ProviderPrivateAccountMutationResult> {
  const receipt = await admitPrivateDelete(deps.transport, accountId, revision);
  return 'status' in receipt ? receipt
    : await accountCallResult(deps, receipt, 'providerAccounts.delete', accountId, revision);
}

async function admitPrivateAccount(
  transport: ProviderAccountsTransport, transaction: PrivateAccountTransaction, account: AccountIntent,
): Promise<PrivateAccountAdmissionResult> {
  return admitPrivateMutation(transport, transaction, 'providerAccounts.replace', {
    kind: 'replace', account, privateTransactionId: transaction.id,
  });
}

async function admitPrivateDelete(
  transport: ProviderAccountsTransport, accountId: string, revision: number,
): Promise<PrivateAccountAdmissionResult> {
  if (!isId(accountId) || !isRevision(revision)) throw new Error('Provider account request is invalid');
  const reference = credentialReference(accountId);
  const transaction = await beginPrivateAccountTransaction(reference, revision, () => credentialSnapshot(reference), restoreCredential);
  return admitPrivateMutation(transport, transaction, 'providerAccounts.delete', {
    kind: 'delete', accountId, revision, privateTransactionId: transaction.id,
  });
}

async function admitPrivateMutation(
  transport: ProviderAccountsTransport,
  transaction: PrivateAccountTransaction,
  command: 'providerAccounts.replace' | 'providerAccounts.delete',
  input: unknown,
): Promise<PrivateAccountAdmissionResult> {
  let response: ProviderMutationTransportResponse;
  try { response = await transport.execute(accountRequest(command, input)); }
  catch { return { status: 'unknown', reason: 'outcome-unknown' }; }
  if (response.status === 202) {
    try { return decodeCallReceipt(response.body); }
    catch { return { status: 'unknown', reason: 'outcome-unknown' }; }
  }
  const notAdmitted = response.status === 400 || response.status === 422
    || response.status === 503 && 'code' in response.body && response.body.code === 'not-admitted';
  if (notAdmitted && !transaction.claimed) {
    try { await settlePrivateAccountTransaction(transaction, 'rejected', restoreCredential); }
    catch { return { status: 'unknown', reason: 'outcome-unknown' }; }
    return {
      status: 'rejected',
      reason: response.status === 400 ? 'invalid-request' : response.status === 422 ? 'rejected' : 'not-admitted',
    };
  }
  return { status: 'unknown', reason: 'outcome-unknown' };
}

async function accountCallResult(
  deps: ProviderPrivateAccountDependencies,
  receipt: CallReceipt,
  command: 'providerAccounts.replace' | 'providerAccounts.delete',
  accountId: string,
  revision: number,
): Promise<ProviderPrivateAccountMutationResult> {
  let record: CallRecord<'provider'>;
  try { record = await deps.awaitProviderCall(receipt, command); }
  catch { return { status: 'unknown' }; }
  const detail = record.detail;
  if (record.callId !== receipt.callId || record.module !== 'provider' || record.command !== command
    || detail.kind !== (command === 'providerAccounts.replace' ? 'replaceAccount' : 'deleteAccount')
    || detail.phase !== 'terminal' || detail.accountId !== accountId || detail.accountRevision !== revision) {
    return { status: 'unknown' };
  }
  providerPrivateAuthTrace('mutation.terminal', () => ({ command, ...detailTrace(detail) }));
  if (detail.diagnostic?.reason === 'private-transaction-settle-failed') return { status: 'unknown', detail };
  const outcome = command === 'providerAccounts.replace' ? 'stored' : 'deleted';
  if (detail.outcome === outcome && detail.persisted === 'confirmed' && detail.commit === 'committed') {
    return { status: outcome, detail };
  }
  return {
    status: detail.outcome === 'rejected' || record.status === 'rejected' ? 'rejected'
      : detail.outcome === 'unavailable' ? 'unavailable' : 'unknown',
    detail,
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
  manualCodes.get(flowId)?.resolve(code);
}

function rejectManualCode(flowId: string): void {
  manualCodes.get(flowId)?.reject();
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

async function deletePrivateAccount(reference: string, profileProvider: string, authProfiles: AuthProfileSqliteWriter): Promise<void> {
  await removePrivateProfile(reference, profileProvider, authProfiles);
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
    if (!isRecord(value)) return null;
    const accounts = Array.isArray(value.accounts)
      ? Object.fromEntries(
        value.accounts
          .filter(isRecord)
          .filter((account): account is Record<string, unknown> & { id: string } => isId(account.id))
          .map((account) => [account.id, account]),
      )
      : Object.fromEntries(
        Object.entries(isRecord(value.accounts) ? value.accounts : {})
          .filter((entry): entry is [string, Record<string, unknown>] => isRecord(entry[1])),
      );
    return {
      accounts,
      apiKeys: Object.fromEntries(
        Object.entries(isRecord(value.apiKeys) ? value.apiKeys : {})
          .filter((entry): entry is [string, string] => typeof entry[1] === 'string'),
      ),
    };
  } catch {
    return null;
  }
}

function storedAccountProvider(account: Record<string, unknown>): string | undefined {
  const provider = typeof account.provider === 'string'
    ? account.provider.replace(/^provider:/, '')
    : account.vendorId;
  return isProviderName(provider) ? provider : undefined;
}

function storedAccountAuthMode(account: Record<string, unknown>): Exclude<AuthMode, 'local'> | 'local' | undefined {
  const mode = account.authMode ?? account.auth_mode;
  if (mode === 'apiKey' || mode === 'api_key') return 'apiKey';
  if (mode === 'oauthBrowser' || mode === 'oauth_browser') return 'oauthBrowser';
  if (mode === 'oauthDevice' || mode === 'oauth_device') return 'oauthDevice';
  if (mode === 'local') return 'local';
  return undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

async function resolvePrivateCredential(reference: string): Promise<string | undefined> {
  const encrypted = (await readStore())[reference];
  if (!encrypted) return undefined;
  const credential = parsePrivateCredential(safeStorage.decryptString(Buffer.from(encrypted, 'base64')));
  if (credential.kind === 'apiKey') return credential.key;
  if (credential.kind === 'token') return credential.token;
  return credential.access;
}

async function applyPrivateProfile(
  reference: string,
  profileProvider: string,
  credentialProvider: string,
  authMode: CredentialAuthMode,
  authProfiles: AuthProfileSqliteWriter,
): Promise<void> {
  providerPrivateAuthTrace('store.private-profile-before', () => ({
    provider: profileProvider,
    sourceProvider: credentialProvider,
    authMode,
    reference: idShape(reference),
  }));
  const encrypted = await readPrivateCredential(reference);
  const credential = decryptPrivateCredential(encrypted);
  const profileId = privateProfileId(profileProvider);
  const legacyProfileId = legacyPrivateProfileId(reference);
  const profile = authMode === 'apiKey'
    ? credential.kind === 'apiKey' && credential.provider === credentialProvider
      ? { type: 'api_key', provider: profileProvider, key: credential.key }
      : undefined
    : authMode === 'token'
      ? credential.kind === 'token' && credential.provider === credentialProvider
        ? { type: 'token', provider: profileProvider, token: credential.token }
        : undefined
      : credential.kind === 'oauth'
        ? oauthProfile(profileProvider, credential)
        : undefined;
  if (!profile) {
    throw new ProviderPrivateResolverError(
      credential.kind === 'apiKey' ? 'credential-provider-mismatch' : 'credential-invalid',
    );
  }

  await authProfiles.update({ type: 'apply', provider: profileProvider, profileId, legacyProfileId, profile });
  providerPrivateAuthTrace('store.private-profile-after', () => ({
    provider: profileProvider,
    sourceProvider: credentialProvider,
    authMode,
    reference: idShape(reference),
    profileId: idShape(profileId),
    legacyProfileId: idShape(legacyProfileId),
  }));
}

function oauthProfile(
  provider: string,
  credential: Extract<ReturnType<typeof parsePrivateCredential>, { kind: 'oauth' }>,
): AuthProfile {
  const { kind: _, ...profile } = credential;
  return { ...profile, type: 'oauth', provider };
}

async function removePrivateProfile(reference: string, profileProvider: string, authProfiles: AuthProfileSqliteWriter): Promise<void> {
  const profileId = privateProfileId(profileProvider);
  const legacyProfileId = legacyPrivateProfileId(reference);
  providerPrivateAuthTrace('delete.private-profile-before', () => ({
    provider: profileProvider,
    reference: idShape(reference),
    profileId: idShape(profileId),
    legacyProfileId: idShape(legacyProfileId),
  }));
  await authProfiles.update({ type: 'remove', profileId, legacyProfileId });
  providerPrivateAuthTrace('delete.private-profile-after', () => ({
    provider: profileProvider,
    reference: idShape(reference),
    profileId: idShape(profileId),
    legacyProfileId: idShape(legacyProfileId),
  }));
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
  if (provider === 'zai-global') return 'zai';
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

function parsePrivateCredential(value: string):
  | Readonly<{ kind: 'apiKey'; provider: string; key: string }>
  | Readonly<{ kind: 'token'; provider: string; token: string }>
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
  if (candidate.kind === 'token' && isProviderName(candidate.provider) && isSecret(candidate.token)) {
    return { kind: 'token', provider: candidate.provider, token: candidate.token };
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
    && account.kind === 'chat'
    && (value.provider === 'openrouter'
      ? account.authMode === 'oauthBrowser'
      : value.provider === 'openai'
        ? account.authMode === 'oauthBrowser' || account.authMode === 'oauthDevice'
        : account.authMode === 'oauthDevice')
    ? { flowId: value.flowId, account, provider: value.provider, controller: new AbortController() }
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
    || account.authMode === 'cliReuse' && (account.provider !== 'anthropic' || kind !== 'chat')
    || account.authMode === 'token' && (kind !== 'chat' || !['anthropic', 'github-copilot'].includes(account.provider))
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
  return value === 'openai' || value === 'openrouter' || value === 'github-copilot'
    || value === 'minimax-portal' || value === 'minimax-portal-cn' || value === 'qwen-portal';
}

function isProfileProviderName(value: unknown): value is string {
  return typeof value === 'string' && value.length <= MAX_PROVIDER_KEY_BYTES && /^[A-Za-z0-9_.-]+$/.test(value);
}

function isProviderName(value: unknown): value is string {
  return typeof value === 'string' && /^[A-Za-z0-9_.-]{1,128}$/.test(value);
}

function isAuthMode(value: unknown): value is AuthMode {
  return value === 'apiKey' || value === 'oauthBrowser' || value === 'oauthDevice'
    || value === 'local' || value === 'token' || value === 'cliReuse';
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
    if (body.operation === 'claim' || body.operation === 'settle') {
      return keys.join(',') === (body.operation === 'claim'
        ? 'operation,reference,revision,transactionId' : 'operation,reference,revision,settlement,transactionId')
        && typeof body.transactionId === 'string'
        && /^[a-f0-9]{8}(-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(body.transactionId)
        && isRevision(body.revision)
        && (body.operation === 'claim' || body.settlement === 'retained' || body.settlement === 'rejected' || body.settlement === 'unknown');
    }
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
