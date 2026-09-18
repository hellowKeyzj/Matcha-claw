import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { ChannelCatalogTransport } from './catalog';
import { beginChannelTrace, channelTraceError } from './trace';

const DEFAULT_WAIT_TIMEOUT_MS = 300_000;
const MAX_TIMEOUT_MS = 300_000;
const QQ_CONNECTOR_SOURCE = 'matcha';
const DINGTALK_REGISTRATION_BASE_URL = 'https://oapi.dingtalk.com';
const DINGTALK_REGISTRATION_SOURCE = 'openClaw';
const FEISHU_ACCOUNTS_URL = 'https://accounts.feishu.cn';
const LARK_ACCOUNTS_URL = 'https://accounts.larksuite.com';
const FEISHU_REGISTRATION_PATH = '/oauth/v1/app/registration';
const FEISHU_REGISTRATION_TP = 'ob_cli_app';

export type ChannelAuthorizationAction = 'start' | 'wait' | 'cancel';
export type ChannelAuthorizationChannel = 'qqbot' | 'dingtalk' | 'feishu';

export type ChannelAuthorizationRequest = Readonly<{
  action: ChannelAuthorizationAction;
  channel: ChannelAuthorizationChannel;
  accountId?: string;
  agentId?: string;
  sessionKey?: string;
  config?: Record<string, unknown>;
  timeoutMs?: number;
}>;

type ChannelAuthorizationProgress = Readonly<{
  outcome: 'progress' | 'connected' | 'target_rejected' | 'unknown' | 'cancelled';
  channel: ChannelAuthorizationChannel;
  accountId?: string;
  sessionKey?: string;
  qrDataUrl?: string;
  authorizationUrl?: string;
  expiresAt?: number;
}>;

const UNKNOWN: ChannelAuthorizationProgress = { outcome: 'unknown', channel: 'qqbot' };

type ChannelAuthorizationTransportResponse = Readonly<{
  status: 200 | 400 | 503;
  body: ChannelAuthorizationProgress | Readonly<{ outcome: 'rejected' }>;
}>;

export interface ChannelAuthorizationTransport {
  authorize(input: ChannelAuthorizationRequest, traceId?: string): Promise<ChannelAuthorizationTransportResponse>;
}

type CredentialResult = Readonly<{ values: Record<string, unknown> }>;

type Session = {
  key: string;
  activeKey: string;
  channel: ChannelAuthorizationChannel;
  accountId: string;
  agentId?: string;
  config: Record<string, unknown>;
  controller: AbortController;
  progress: ChannelAuthorizationProgress;
  result: Promise<CredentialResult>;
  stop?: () => void;
};

type QrCodeModule = Readonly<{
  toDataURL: (text: string, options?: Record<string, unknown>) => Promise<string>;
}>;

type QqbotConnector = Readonly<{
  startQrConnect: (
    callbacks: {
      onSuccess: (credentials: readonly { appId: string; appSecret: string }[]) => void;
      onFailure: (error: Error) => void;
      onQrDisplayed?: (url: string) => void;
      onQrExpired?: () => void;
    },
    options?: { displayQrCodeToConsole?: boolean; signal?: AbortSignal; source?: string },
  ) => () => void;
}>;

type DingtalkPollResult = Readonly<{
  status: 'WAITING' | 'SUCCESS' | 'FAIL' | 'EXPIRED';
  clientId?: string;
  clientSecret?: string;
  failReason?: string;
}>;

type FeishuDomain = 'feishu' | 'lark';
type FeishuPollOutcome =
  | Readonly<{ status: 'success'; values: Record<string, unknown> }>
  | Readonly<{ status: 'pending' }>
  | Readonly<{ status: 'access_denied' | 'expired' | 'timeout' | 'error'; message?: string }>;

export function createChannelAuthorizationTransport(
  configureTransport: ChannelCatalogTransport,
): ChannelAuthorizationTransport {
  const require = createRequire(import.meta.url);
  const sessions = new Map<string, Session>();
  const activeSessions = new Map<string, string>();

  const cancelSession = (session: Session) => {
    session.stop?.();
    session.controller.abort();
    sessions.delete(session.key);
    if (activeSessions.get(session.activeKey) === session.key) activeSessions.delete(session.activeKey);
  };

  const toQrDataUrl = async (value: string): Promise<string> => {
    const qr = require('qrcode') as QrCodeModule;
    return await qr.toDataURL(value, { errorCorrectionLevel: 'M', margin: 1, width: 288 });
  };

  const finishAuthorization = async (
    session: Session,
    values: Record<string, unknown>,
    traceId: string | undefined,
  ): Promise<ChannelAuthorizationTransportResponse> => {
    const response = await configureTransport.apply({
      channel: session.channel,
      accountId: session.accountId,
      ...(session.agentId ? { agentId: session.agentId } : {}),
      values: { ...session.config, ...values },
    }, traceId);

    sessions.delete(session.key);
    if (activeSessions.get(session.activeKey) === session.key) activeSessions.delete(session.activeKey);

    const body = response.body;
    if (response.status === 200 && isConfigureOutcome(body)) {
      if (body.outcome === 'confirmed') {
        return {
          status: 200,
          body: {
            outcome: 'connected',
            channel: session.channel,
            accountId: session.accountId,
            sessionKey: session.key,
          },
        };
      }
      return {
        status: 200,
        body: {
          outcome: body.outcome === 'target_rejected' ? 'target_rejected' : 'unknown',
          channel: session.channel,
          accountId: session.accountId,
          sessionKey: session.key,
        },
      };
    }

    return {
      status: 503,
      body: {
        outcome: 'unknown',
        channel: session.channel,
        accountId: session.accountId,
        sessionKey: session.key,
      },
    };
  };

  const startSession = async (
    input: ChannelAuthorizationRequest,
    traceId: string | undefined,
  ): Promise<ChannelAuthorizationTransportResponse> => {
    const accountId = input.accountId || 'default';
    const key = randomUUID();
    const activeKey = `${input.channel}:${accountId}`;
    const previous = activeSessions.get(activeKey);
    if (previous) {
      const session = sessions.get(previous);
      if (session) cancelSession(session);
    }

    const sessionBase = {
      key,
      activeKey,
      channel: input.channel,
      accountId,
      ...(input.agentId ? { agentId: input.agentId } : {}),
      config: input.config ?? {},
      controller: new AbortController(),
    } satisfies Omit<Session, 'progress' | 'result' | 'stop'>;

    let session: Session;
    if (input.channel === 'qqbot') {
      session = await startQqbotSession(sessionBase, require, toQrDataUrl);
    } else if (input.channel === 'dingtalk') {
      session = await startDingtalkSession(sessionBase, toQrDataUrl);
    } else {
      session = await startFeishuSession(sessionBase, toQrDataUrl);
    }

    sessions.set(key, session);
    activeSessions.set(activeKey, key);

    if (session.progress.outcome === 'connected') {
      const result = await session.result;
      return await finishAuthorization(session, result.values, traceId);
    }

    return { status: 200, body: session.progress };
  };

  return {
    async authorize(input, traceId): Promise<ChannelAuthorizationTransportResponse> {
      if (!isRequest(input)) return { status: 400, body: { outcome: 'rejected' } };
      const finish = beginChannelTrace(`transport.authorization.${input.action}`, traceId);
      let response!: ChannelAuthorizationTransportResponse;
      let errorCode: ReturnType<typeof channelTraceError> | 'INVALID_RESPONSE' | undefined;

      try {
        if (input.action === 'start') {
          response = await startSession(input, traceId);
        } else if (!input.sessionKey) {
          response = { status: 400, body: { outcome: 'rejected' } };
        } else {
          const session = sessions.get(input.sessionKey);
          if (!session || session.channel !== input.channel) {
            response = { status: 503, body: { ...UNKNOWN, channel: input.channel } };
          } else if (input.action === 'cancel') {
            cancelSession(session);
            response = { status: 200, body: { outcome: 'cancelled', channel: session.channel, accountId: session.accountId, sessionKey: session.key } };
          } else {
            try {
              const result = await waitForResult(session.result, input.timeoutMs ?? DEFAULT_WAIT_TIMEOUT_MS);
              response = result
                ? await finishAuthorization(session, result.values, traceId)
                : { status: 200, body: session.progress };
            } catch (error) {
              if (!isAuthorizationCancelled(error)) throw error;
              response = {
                status: 200,
                body: { outcome: 'cancelled', channel: session.channel, accountId: session.accountId, sessionKey: session.key },
              };
            }
          }
        }
      } catch (error) {
        errorCode = channelTraceError(error);
        response = { status: 503, body: { ...UNKNOWN, channel: input.channel } };
      } finally {
        finish(response.status, response.body, errorCode);
      }
      return response;
    },
  };
}

async function startQqbotSession(
  base: Omit<Session, 'progress' | 'result' | 'stop'>,
  require: NodeRequire,
  toQrDataUrl: (value: string) => Promise<string>,
): Promise<Session> {
  const connector = await loadQqbotConnector(require);
  let stop: (() => void) | undefined;
  let progressReady!: (progress: ChannelAuthorizationProgress) => void;
  let progressFailed!: (error: Error) => void;
  const progress = new Promise<ChannelAuthorizationProgress>((resolve, reject) => {
    progressReady = resolve;
    progressFailed = reject;
  });

  const result = new Promise<CredentialResult>((resolve, reject) => {
    stop = connector.startQrConnect({
      onQrDisplayed(url) {
        void toQrDataUrl(url).then((qrDataUrl) => {
          progressReady({
            outcome: 'progress',
            channel: 'qqbot',
            accountId: base.accountId,
            sessionKey: base.key,
            qrDataUrl,
            authorizationUrl: url,
          });
        }).catch(progressFailed);
      },
      onSuccess(credentials) {
        const credential = credentials[0];
        if (!credential?.appId || !credential.appSecret) {
          reject(new Error('QQ Bot binding completed without credentials'));
          return;
        }
        resolve({ values: { appId: credential.appId, clientSecret: credential.appSecret } });
      },
      onFailure(error) {
        reject(error);
      },
      onQrExpired() {
        // The connector refreshes and emits a new QR URL; keep the last stable prompt meanwhile.
      },
    }, { displayQrCodeToConsole: false, signal: base.controller.signal, source: QQ_CONNECTOR_SOURCE });
  });

  const initialProgress = await progress;
  return { ...base, progress: initialProgress, result, ...(stop ? { stop } : {}) };
}

async function loadQqbotConnector(require: NodeRequire): Promise<QqbotConnector> {
  const qqbotPackage = require.resolve('@openclaw/qqbot/package.json');
  const qqbotRequire = createRequire(qqbotPackage);
  const connectorCjsPath = qqbotRequire.resolve('@tencent-connect/qqbot-connector');
  const connectorRoot = dirname(dirname(dirname(connectorCjsPath)));
  const connectorEsmPath = join(connectorRoot, 'dist', 'esm', 'index.js');
  return await import(pathToFileURL(connectorEsmPath).href) as QqbotConnector;
}

async function startDingtalkSession(
  base: Omit<Session, 'progress' | 'result' | 'stop'>,
  toQrDataUrl: (value: string) => Promise<string>,
): Promise<Session> {
  const nonceBody = await postJson<Record<string, unknown>>(`${DINGTALK_REGISTRATION_BASE_URL}/app/registration/init`, {
    source: DINGTALK_REGISTRATION_SOURCE,
  });
  const nonce = readNonEmptyString(nonceBody.nonce);
  if (!nonce) throw new Error('DingTalk registration init did not return a nonce');

  const beginBody = await postJson<Record<string, unknown>>(`${DINGTALK_REGISTRATION_BASE_URL}/app/registration/begin`, { nonce });
  const deviceCode = readNonEmptyString(beginBody.device_code);
  const authorizationUrl = readNonEmptyString(beginBody.verification_uri_complete);
  if (!deviceCode || !authorizationUrl) throw new Error('DingTalk registration did not return an authorization URL');

  const intervalSeconds = Math.max(Number(beginBody.interval ?? 3) || 3, 2);
  const expiresInSeconds = Number(beginBody.expires_in ?? 7200) || 7200;
  const expiresAt = Date.now() + expiresInSeconds * 1000;
  const qrDataUrl = await toQrDataUrl(authorizationUrl);

  const result = waitForDingtalkCredentials(deviceCode, intervalSeconds, expiresAt, base.controller.signal)
    .then((values) => ({ values }));

  return {
    ...base,
    progress: {
      outcome: 'progress',
      channel: 'dingtalk',
      accountId: base.accountId,
      sessionKey: base.key,
      qrDataUrl,
      authorizationUrl,
      expiresAt,
    },
    result,
  };
}

async function waitForDingtalkCredentials(
  deviceCode: string,
  intervalSeconds: number,
  expiresAt: number,
  signal: AbortSignal,
): Promise<Record<string, unknown>> {
  while (Date.now() < expiresAt) {
    await sleep(intervalSeconds * 1000, signal);
    const poll = await pollDingtalk(deviceCode);
    if (poll.status === 'WAITING') continue;
    if (poll.status === 'SUCCESS') {
      if (!poll.clientId || !poll.clientSecret) throw new Error('DingTalk authorization completed without credentials');
      return { clientId: poll.clientId, clientSecret: poll.clientSecret };
    }
    if (poll.status === 'EXPIRED') throw new Error('DingTalk authorization expired');
    throw new Error(poll.failReason || 'DingTalk authorization failed');
  }
  throw new Error('DingTalk authorization timed out');
}

async function pollDingtalk(deviceCode: string): Promise<DingtalkPollResult> {
  const body = await postJson<Record<string, unknown>>(`${DINGTALK_REGISTRATION_BASE_URL}/app/registration/poll`, {
    device_code: deviceCode,
  });
  const status = readNonEmptyString(body.status)?.toUpperCase();
  return {
    status: status === 'WAITING' || status === 'SUCCESS' || status === 'EXPIRED' ? status : 'FAIL',
    clientId: readNonEmptyString(body.client_id),
    clientSecret: readNonEmptyString(body.client_secret),
    failReason: readNonEmptyString(body.fail_reason),
  };
}

async function startFeishuSession(
  base: Omit<Session, 'progress' | 'result' | 'stop'>,
  toQrDataUrl: (value: string) => Promise<string>,
): Promise<Session> {
  const initialDomain = base.config.domain === 'lark' ? 'lark' : 'feishu';
  await postFeishuRegistration(initialDomain, { action: 'init' });
  const begin = await postFeishuRegistration<Record<string, unknown>>(initialDomain, {
    action: 'begin',
    archetype: 'PersonalAgent',
    auth_method: 'client_secret',
    request_user_info: 'open_id',
  });

  const deviceCode = readNonEmptyString(begin.device_code);
  const rawAuthorizationUrl = readNonEmptyString(begin.verification_uri_complete);
  if (!deviceCode || !rawAuthorizationUrl) throw new Error('Feishu registration did not return an authorization URL');

  const authorizationUrl = new URL(rawAuthorizationUrl);
  authorizationUrl.searchParams.set('from', 'oc_onboard');
  authorizationUrl.searchParams.set('tp', FEISHU_REGISTRATION_TP);
  const intervalSeconds = Math.max(Number(begin.interval ?? 5) || 5, 2);
  const expiresInSeconds = Number(begin.expire_in ?? begin.expires_in ?? 600) || 600;
  const expiresAt = Date.now() + expiresInSeconds * 1000;
  const authorizationUrlString = authorizationUrl.toString();
  const qrDataUrl = await toQrDataUrl(authorizationUrlString);

  const result = waitForFeishuCredentials({
    deviceCode,
    intervalSeconds,
    expiresAt,
    domain: initialDomain,
    signal: base.controller.signal,
  }).then((values) => ({ values }));

  return {
    ...base,
    progress: {
      outcome: 'progress',
      channel: 'feishu',
      accountId: base.accountId,
      sessionKey: base.key,
      qrDataUrl,
      authorizationUrl: authorizationUrlString,
      expiresAt,
    },
    result,
  };
}

async function waitForFeishuCredentials(params: {
  deviceCode: string;
  intervalSeconds: number;
  expiresAt: number;
  domain: FeishuDomain;
  signal: AbortSignal;
}): Promise<Record<string, unknown>> {
  let domain = params.domain;
  let domainSwitched = false;
  let intervalSeconds = params.intervalSeconds;

  while (Date.now() < params.expiresAt) {
    await sleep(intervalSeconds * 1000, params.signal);
    const outcome = await pollFeishu(params.deviceCode, domain);
    if (outcome.status === 'pending') continue;
    if (outcome.status === 'success') return outcome.values;
    if (outcome.status === 'error' && outcome.message === 'tenant_brand:lark' && !domainSwitched) {
      domain = 'lark';
      domainSwitched = true;
      continue;
    }
    if (outcome.status === 'error' && outcome.message === 'slow_down') {
      intervalSeconds += 5;
      continue;
    }
    throw new Error(outcome.message || `Feishu authorization ${outcome.status}`);
  }
  throw new Error('Feishu authorization timed out');
}

async function pollFeishu(deviceCode: string, domain: FeishuDomain): Promise<FeishuPollOutcome> {
  const body = await postFeishuRegistration<Record<string, unknown>>(domain, {
    action: 'poll',
    device_code: deviceCode,
    tp: FEISHU_REGISTRATION_TP,
  });

  const tenantBrand = isRecord(body.user_info) ? readNonEmptyString(body.user_info.tenant_brand) : undefined;
  if (tenantBrand === 'lark' && domain !== 'lark') return { status: 'error', message: 'tenant_brand:lark' };

  const appId = readNonEmptyString(body.client_id);
  const appSecret = readNonEmptyString(body.client_secret);
  if (appId && appSecret) {
    const openId = isRecord(body.user_info) ? readNonEmptyString(body.user_info.open_id) : undefined;
    return {
      status: 'success',
      values: {
        appId,
        appSecret,
        domain,
        connectionMode: 'websocket',
        ...(openId ? { dmPolicy: 'allowlist', allowFrom: [openId] } : {}),
      },
    };
  }

  const error = readNonEmptyString(body.error);
  if (!error || error === 'authorization_pending') return { status: 'pending' };
  if (error === 'slow_down') return { status: 'error', message: 'slow_down' };
  if (error === 'access_denied') return { status: 'access_denied' };
  if (error === 'expired_token') return { status: 'expired' };
  return { status: 'error', message: `${error}: ${readNonEmptyString(body.error_description) || 'unknown'}` };
}

async function postFeishuRegistration<T extends Record<string, unknown>>(
  domain: FeishuDomain,
  body: Record<string, string>,
): Promise<T> {
  const baseUrl = domain === 'lark' ? LARK_ACCOUNTS_URL : FEISHU_ACCOUNTS_URL;
  const response = await fetch(`${baseUrl}${FEISHU_REGISTRATION_PATH}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(body).toString(),
  });
  const json = await response.json() as unknown;
  if (!isRecord(json)) throw new Error('Feishu registration returned invalid JSON');
  return json as T;
}

async function postJson<T extends Record<string, unknown>>(
  url: string,
  body: Record<string, unknown>,
): Promise<T> {
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify(body),
  });
  const json = await response.json() as unknown;
  if (!isRecord(json)) throw new Error('Channel authorization returned invalid JSON');
  const code = json.errcode;
  if (code !== undefined && code !== 0) {
    throw new Error(readNonEmptyString(json.errmsg) || 'Channel authorization request failed');
  }
  return json as T;
}

function isAuthorizationCancelled(error: unknown): boolean {
  return error instanceof Error && error.message === 'authorization cancelled';
}

function waitForResult<T>(promise: Promise<T>, timeoutMs: number): Promise<T | null> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => resolve(null), Math.min(timeoutMs, MAX_TIMEOUT_MS));
    promise.then((value) => {
      clearTimeout(timeout);
      resolve(value);
    }, (error) => {
      clearTimeout(timeout);
      reject(error);
    });
  });
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(new Error('authorization cancelled'));
      return;
    }
    const timeout = setTimeout(resolve, ms);
    signal.addEventListener('abort', () => {
      clearTimeout(timeout);
      reject(new Error('authorization cancelled'));
    }, { once: true });
  });
}

function isRequest(value: unknown): value is ChannelAuthorizationRequest {
  if (!isRecord(value)) return false;
  if (value.action !== 'start' && value.action !== 'wait' && value.action !== 'cancel') return false;
  if (value.channel !== 'qqbot' && value.channel !== 'dingtalk' && value.channel !== 'feishu') return false;
  if (value.accountId !== undefined && !isIdentity(value.accountId)) return false;
  if (value.agentId !== undefined && !isIdentity(value.agentId)) return false;
  if (value.sessionKey !== undefined && !isIdentity(value.sessionKey)) return false;
  if (value.timeoutMs !== undefined && !isTimeout(value.timeoutMs)) return false;
  if (value.config !== undefined && !isConfig(value.config)) return false;

  const keys = Object.keys(value);
  if (value.action === 'start') {
    return keys.every((key) => ['action', 'channel', 'accountId', 'agentId', 'config', 'timeoutMs'].includes(key));
  }
  return keys.every((key) => ['action', 'channel', 'accountId', 'sessionKey', 'timeoutMs'].includes(key));
}

function isConfigureOutcome(value: unknown): value is Readonly<{ outcome: 'confirmed' | 'target_rejected' | 'unknown' }> {
  return isRecord(value)
    && Object.keys(value).length === 1
    && (value.outcome === 'confirmed' || value.outcome === 'target_rejected' || value.outcome === 'unknown');
}

function readNonEmptyString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function isIdentity(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 128 && !/\s/.test(value);
}

function isTimeout(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0 && value <= MAX_TIMEOUT_MS;
}

function isConfig(value: unknown): value is Record<string, unknown> {
  if (!isRecord(value)) return false;
  const serialized = JSON.stringify(value);
  return serialized !== undefined && Buffer.byteLength(serialized, 'utf8') <= 16_384;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
