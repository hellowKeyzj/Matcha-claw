import { addAbortListener } from 'node:events';
import { type BrowserWindow, safeStorage, shell } from 'electron';
import { isId, isSecret, isProvider, parseAccount, type OAuthProvider as Provider, type ProviderAccountIntent as AccountIntent } from '../account-intent';
import { commitPrivateAccount, type ProviderPrivateAccountDependencies, type PrivateAccountAdmissionResult, type PublicMutationOutcome } from '../accounts';
import type { PrivateCredential } from '../credentials';
import { loginOpenAICodexOAuth } from './openai-codex-oauth';
import { loginOpenAIDeviceOAuth } from './openai-device-oauth';
import { loginGitHubCopilotDeviceOAuth } from './github-copilot-device-oauth';
import { loginOpenRouterOAuth } from './openrouter-oauth';
import { loginMiniMaxPortalOAuth, loginQwenPortalOAuth } from './device-oauth-providers';

const OAUTH_ERROR_MESSAGE = 'Provider OAuth authentication failed';
type Flow = Readonly<{ flowId: string; account: AccountIntent; provider: Provider; controller: AbortController }>;
type PublicOAuthOutcome = 'completed' | 'rejected' | 'unknown' | 'unavailable';
const activeFlows = new Map<string, Flow>();
const manualCodes = new Map<string, { resolve: (value: string) => void; reject: () => void }>();

export function createProviderOAuthActions(
  getMainWindow: () => BrowserWindow | null,
  runtime: Promise<ProviderPrivateAccountDependencies>,
  signal: AbortSignal,
  trackMutation: (mutate: () => Promise<PrivateAccountAdmissionResult>) => Promise<PrivateAccountAdmissionResult>,
) {
  const pending = new Set<Promise<unknown>>();
  const track = <T>(task: Promise<T>): Promise<T> => {
    pending.add(task);
    return task.finally(() => { pending.delete(task); });
  };
  const startOAuth = async (input: unknown) => {
    const flow = parseFlow(input);
    if (!flow || !safeStorage.isEncryptionAvailable()) {
      throw new Error('Provider OAuth request is invalid');
    }
    if (activeFlows.has(flow.flowId)) throw new Error('Provider OAuth flow is already active');
    if (signal.aborted) throw new Error(OAUTH_ERROR_MESSAGE);
    activeFlows.set(flow.flowId, flow);
    let runtimeAbort: ReturnType<typeof addAbortListener> | undefined;
    try {
      const deps = await new Promise<ProviderPrivateAccountDependencies>((resolve, reject) => {
        const waiting = AbortSignal.any([signal, flow.controller.signal]);
        runtimeAbort = addAbortListener(waiting, () => reject(waiting.reason));
        void runtime.then(resolve, reject);
      });
      if (signal.aborted || flow.controller.signal.aborted || activeFlows.get(flow.flowId) !== flow) {
        throw new Error(OAUTH_ERROR_MESSAGE);
      }
      publish(getMainWindow, { flowId: flow.flowId, status: 'started' });
      void track(runOAuth(flow, getMainWindow, deps, signal, trackMutation));
      return { flowId: flow.flowId, status: 'started' as const };
    } catch {
      if (activeFlows.get(flow.flowId) === flow) activeFlows.delete(flow.flowId);
      throw new Error(OAUTH_ERROR_MESSAGE);
    } finally {
      runtimeAbort?.[Symbol.dispose]();
    }
  };

  const submitOAuthCode = async (input: unknown) => {
    const value = input as { flowId?: unknown; code?: unknown };
    if (!isId(value.flowId) || !isSecret(value.code)) throw new Error('Provider OAuth request is invalid');
    const flow = activeFlows.get(value.flowId);
    if (!flow || flow.provider !== 'openai' || flow.account.authMode !== 'oauthBrowser') {
      throw new Error('Provider OAuth flow is unavailable');
    }
    if (signal.aborted) throw new Error(OAUTH_ERROR_MESSAGE);
    resolveManualCode(flow.flowId, value.code);
    return { flowId: flow.flowId, status: 'submitted' as const };
  };

  const cancelOAuth = async (input: unknown) => {
    const flowId = (input as { flowId?: unknown })?.flowId;
    if (!isId(flowId)) throw new Error('Provider OAuth request is invalid');
    if (signal.aborted) throw new Error(OAUTH_ERROR_MESSAGE);
    activeFlows.get(flowId)?.controller.abort();
    activeFlows.delete(flowId);
    rejectManualCode(flowId);
    publish(getMainWindow, { flowId, status: 'cancelled' });
    return { flowId, status: 'cancelled' as const };
  };
  return {
    startOAuth: (input: unknown) => track(startOAuth(input)),
    submitOAuthCode,
    cancelOAuth,
    drain: async () => {
      while (pending.size > 0) await Promise.allSettled(pending);
    },
  };
}

async function runOAuth(
  flow: Flow,
  getMainWindow: () => BrowserWindow | null,
  deps: ProviderPrivateAccountDependencies,
  signal: AbortSignal,
  trackMutation: (mutate: () => Promise<PrivateAccountAdmissionResult>) => Promise<PrivateAccountAdmissionResult>,
): Promise<void> {
  const shutdownListener = addAbortListener(signal, () => flow.controller.abort(signal.reason));
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
    const replacement = await commitPrivateAccount(deps, account, secret, trackMutation);
    if (signal.aborted) return;
    publish(getMainWindow, { flowId: flow.flowId, status: oauthOutcome(replacement.outcome) });
    if (replacement.outcome === 'stored') {
      publishLegacy(getMainWindow, flow, 'oauth:success', {
        success: true,
      }, replacement.accountId ?? flow.account.id);
    } else {
      publishLegacy(getMainWindow, flow, 'oauth:error', {
        message: oauthErrorMessage(replacement.outcome),
        outcome: replacement.outcome,
      });
    }
  } catch {
    if (!signal.aborted && (flowClaimed || activeFlows.get(flow.flowId) === flow)) {
      if (activeFlows.get(flow.flowId) === flow) activeFlows.delete(flow.flowId);
      publish(getMainWindow, { flowId: flow.flowId, status: 'unknown' });
      publishLegacy(getMainWindow, flow, 'oauth:error', {
        message: OAUTH_ERROR_MESSAGE,
        outcome: flowClaimed ? 'unknown' : 'unavailable',
      });
    }
  } finally {
    shutdownListener[Symbol.dispose]();
    if (signal.aborted && activeFlows.get(flow.flowId) === flow) activeFlows.delete(flow.flowId);
    if (!activeFlows.has(flow.flowId)) rejectManualCode(flow.flowId);
  }
}

async function loginFlow(flow: Flow, getMainWindow: () => BrowserWindow | null): Promise<PrivateCredential> {
  const signal = flow.controller.signal;
  const openUrl = async (url: string) => {
    signal.throwIfAborted();
    await shell.openExternal(url);
  };
  const onVerification = (info: { verificationUri: string; userCode: string; expiresIn: number }) => {
    if (signal.aborted) return;
    publish(getMainWindow, { flowId: flow.flowId, status: 'device_code', ...info });
    publishLegacy(getMainWindow, flow, 'oauth:code', info);
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
      publishLegacy(getMainWindow, flow, 'oauth:code', {
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
    if (flow.controller.signal.aborted) return;
    const verificationUri = message.match(/Open\s+(https?:\/\/\S+?)\s+to/i)?.[1];
    const userCode = verificationUri ? new URL(verificationUri).searchParams.get('user_code') : undefined;
    if (verificationUri && userCode) {
      publish(getMainWindow, { flowId: flow.flowId, status: 'device_code', verificationUri, userCode, expiresIn: 300 });
      publishLegacy(getMainWindow, flow, 'oauth:code', {
        verificationUri,
        userCode,
        expiresIn: 300,
      });
    }
  };
  const openUrl = async (url: string) => { flow.controller.signal.throwIfAborted(); await shell.openExternal(url); };
  const signal = flow.controller.signal;
  const token = flow.provider === 'qwen-portal'
    ? await loginQwenPortalOAuth({ openUrl, note, signal, progress: { update: () => {}, stop: () => {} } })
    : await loginMiniMaxPortalOAuth({
      region: flow.provider === 'minimax-portal-cn' ? 'cn' : 'global',
      signal,
      openUrl,
      note,
      progress: { update: () => {}, stop: () => {} },
    });
  return { kind: 'oauth', access: token.access, refresh: token.refresh, expires: token.expires };
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

function publish(getMainWindow: () => BrowserWindow | null, payload: Record<string, unknown>): void {
  getMainWindow()?.webContents.send('host:event', { eventName: 'provider-oauth', payload });
}

function publishLegacy(
  getMainWindow: () => BrowserWindow | null,
  flow: Flow,
  eventName: 'oauth:code' | 'oauth:success' | 'oauth:error',
  payload: Record<string, unknown>,
  accountId = flow.account.id,
): void {
  getMainWindow()?.webContents.send('host:event', {
    eventName,
    payload: { ...payload, flowId: flow.flowId, accountId, provider: flow.provider },
  });
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
