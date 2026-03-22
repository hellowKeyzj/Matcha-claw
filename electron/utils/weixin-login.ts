import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { normalizeAccountId } from 'openclaw/plugin-sdk/account-id';
import QRCode from 'qrcode';

const DEFAULT_BASE_URL = 'https://ilinkai.weixin.qq.com';
const DEFAULT_BOT_TYPE = '3';
const LOGIN_TIMEOUT_MS = 480_000;
const LONG_POLL_TIMEOUT_MS = 35_000;
const QR_FETCH_TIMEOUT_MS = 8_000;
const MAX_QR_REFRESH_COUNT = 3;
const POLL_RETRY_DELAY_MS = 1000;

type WeixinQrResponse = {
  qrcode: string;
  qrcode_img_content: string;
};

type WeixinStatusResponse = {
  status: 'wait' | 'scaned' | 'confirmed' | 'expired';
  bot_token?: string;
  ilink_bot_id?: string;
  ilink_user_id?: string;
  baseurl?: string;
};

type ActiveLogin = {
  sessionKey: string;
  accountId: string;
  baseUrl: string;
  routeTag?: string;
  qrcode: string;
  qrcodeUrl: string;
  startedAt: number;
  refreshCount: number;
};

export type WeixinLoginStartOptions = {
  accountId?: string;
  baseUrl?: string;
  routeTag?: string;
  timeoutMs?: number;
};

function resolveStateDir(): string {
  return process.env.OPENCLAW_STATE_DIR?.trim()
    || process.env.CLAWDBOT_STATE_DIR?.trim()
    || join(homedir(), '.openclaw');
}

function resolveWeixinStateDir(): string {
  return join(resolveStateDir(), 'openclaw-weixin');
}

function resolveAccountsDir(): string {
  return join(resolveWeixinStateDir(), 'accounts');
}

function resolveAccountsIndexPath(): string {
  return join(resolveWeixinStateDir(), 'accounts.json');
}

function normalizeBaseUrl(input?: string): string {
  const value = (input || DEFAULT_BASE_URL).trim();
  return value.endsWith('/') ? value.slice(0, -1) : value;
}

function normalizeRouteTag(input?: string): string | undefined {
  const value = input?.trim();
  return value ? value : undefined;
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === 'AbortError';
}

function parseJson<T>(value: unknown): T {
  return value as T;
}

function isDataUrl(value: string): boolean {
  return /^data:image\/[a-zA-Z0-9.+-]+;base64,/i.test(value);
}

function isLikelyBase64(value: string): boolean {
  const normalized = value.replace(/\s+/g, '');
  return normalized.length > 80 && /^[A-Za-z0-9+/=]+$/.test(normalized);
}

async function fetchWithTimeout(url: string, options: RequestInit, timeoutMs: number): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, {
      ...options,
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timer);
  }
}

async function normalizeQrImageContentToDataUrl(
  rawValue: string,
): Promise<string> {
  const value = rawValue.trim();
  if (!value) {
    throw new Error('二维码图片内容为空');
  }
  if (isDataUrl(value)) {
    return value;
  }
  if (isLikelyBase64(value)) {
    return `data:image/png;base64,${value.replace(/\s+/g, '')}`;
  }
  // 腾讯返回的 qrcode_img_content 常常是“可扫码链接”而不是图片资源，直接转成本地 PNG dataURL 最稳。
  return QRCode.toDataURL(value, {
    errorCorrectionLevel: 'M',
    margin: 1,
    width: 360,
  });
}

async function readJsonArray(path: string): Promise<string[]> {
  try {
    const raw = await readFile(path, 'utf8');
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) {
      return [];
    }
    return parsed.filter((item): item is string => typeof item === 'string' && item.trim().length > 0);
  } catch {
    return [];
  }
}

async function saveWeixinAccountData(params: {
  normalizedAccountId: string;
  token: string;
  baseUrl: string;
  userId?: string;
}): Promise<void> {
  const stateDir = resolveWeixinStateDir();
  const accountsDir = resolveAccountsDir();
  await mkdir(stateDir, { recursive: true });
  await mkdir(accountsDir, { recursive: true });

  const accountFilePath = join(accountsDir, `${params.normalizedAccountId}.json`);
  const accountPayload: Record<string, unknown> = {
    token: params.token,
    baseUrl: params.baseUrl,
    savedAt: new Date().toISOString(),
  };
  if (params.userId?.trim()) {
    accountPayload.userId = params.userId.trim();
  }
  await writeFile(accountFilePath, JSON.stringify(accountPayload, null, 2), 'utf8');

  const indexPath = resolveAccountsIndexPath();
  const existingIds = await readJsonArray(indexPath);
  if (!existingIds.includes(params.normalizedAccountId)) {
    await writeFile(indexPath, JSON.stringify([...existingIds, params.normalizedAccountId], null, 2), 'utf8');
  }
}

export class WeixinLoginManager extends EventEmitter {
  private activeLogin: ActiveLogin | null = null;
  private running = false;
  private pollTask: Promise<void> | null = null;
  private externalAbortController: AbortController | null = null;

  async start(options: WeixinLoginStartOptions): Promise<void> {
    const accountId = options.accountId?.trim() || randomUUID();
    const baseUrl = normalizeBaseUrl(options.baseUrl);
    const routeTag = normalizeRouteTag(options.routeTag);
    const timeoutMs = typeof options.timeoutMs === 'number' && options.timeoutMs > 0
      ? options.timeoutMs
      : LOGIN_TIMEOUT_MS;

    await this.stop();
    this.running = true;

    const qrResult = await this.fetchQrCode(baseUrl, routeTag);
    this.activeLogin = {
      sessionKey: accountId,
      accountId,
      baseUrl,
      routeTag,
      qrcode: qrResult.qrcode,
      qrcodeUrl: qrResult.qrcode_img_content,
      startedAt: Date.now(),
      refreshCount: 1,
    };

    this.emit('qr', {
      sessionKey: accountId,
      accountId,
      qrDataUrl: qrResult.qrcode_img_content,
      raw: qrResult.qrcode,
    });

    this.pollTask = this.pollUntilDone(timeoutMs);
  }

  startInBackground(options: WeixinLoginStartOptions): void {
    void this.start(options).catch((error) => {
      this.running = false;
      this.activeLogin = null;
      const message = error instanceof Error ? error.message : String(error);
      this.emit('error', message);
    });
  }

  async stop(): Promise<void> {
    this.running = false;
    this.activeLogin = null;
    if (this.externalAbortController) {
      this.externalAbortController.abort();
      this.externalAbortController = null;
    }

    if (this.pollTask) {
      try {
        await this.pollTask;
      } catch {
        // ignored
      } finally {
        this.pollTask = null;
      }
    }
  }

  private async pollUntilDone(timeoutMs: number): Promise<void> {
    const deadline = Date.now() + timeoutMs;

    while (this.running && this.activeLogin && Date.now() < deadline) {
      const current = this.activeLogin;
      try {
        const status = await this.pollQrStatus(current);
        if (!this.running || !this.activeLogin) {
          return;
        }

        if (status.status === 'wait' || status.status === 'scaned') {
          continue;
        }

        if (status.status === 'expired') {
          if (current.refreshCount >= MAX_QR_REFRESH_COUNT) {
            this.running = false;
            this.activeLogin = null;
            this.emit('error', '二维码多次过期，请重新发起登录。');
            return;
          }

          const refreshed = await this.fetchQrCode(current.baseUrl, current.routeTag);
          if (!this.running || !this.activeLogin) {
            return;
          }

          this.activeLogin = {
            ...current,
            qrcode: refreshed.qrcode,
            qrcodeUrl: refreshed.qrcode_img_content,
            startedAt: Date.now(),
            refreshCount: current.refreshCount + 1,
          };
          this.emit('qr', {
            sessionKey: current.sessionKey,
            accountId: current.accountId,
            qrDataUrl: refreshed.qrcode_img_content,
            raw: refreshed.qrcode,
          });
          continue;
        }

        if (status.status === 'confirmed') {
          if (!status.ilink_bot_id || !status.bot_token) {
            this.running = false;
            this.activeLogin = null;
            this.emit('error', '扫码已确认，但登录凭据返回不完整。');
            return;
          }

          const normalizedId = normalizeAccountId(status.ilink_bot_id);
          const persistedBaseUrl = normalizeBaseUrl(status.baseurl || current.baseUrl);
          await saveWeixinAccountData({
            normalizedAccountId: normalizedId,
            token: status.bot_token,
            baseUrl: persistedBaseUrl,
            userId: status.ilink_user_id,
          });

          this.running = false;
          this.activeLogin = null;
          this.emit('success', {
            sessionKey: current.sessionKey,
            requestedAccountId: current.accountId,
            accountId: normalizedId,
            userId: status.ilink_user_id,
            baseUrl: persistedBaseUrl,
          });
          return;
        }
      } catch (error) {
        if (isAbortError(error)) {
          return;
        }
        this.running = false;
        this.activeLogin = null;
        const message = error instanceof Error ? error.message : String(error);
        this.emit('error', message);
        return;
      }

      await new Promise((resolve) => setTimeout(resolve, POLL_RETRY_DELAY_MS));
    }

    if (this.running) {
      this.running = false;
      this.activeLogin = null;
      this.emit('error', '登录超时，请重试。');
    }
  }

  private async fetchQrCode(baseUrl: string, routeTag?: string): Promise<WeixinQrResponse> {
    const headers: Record<string, string> = {};
    if (routeTag) {
      headers.SKRouteTag = routeTag;
    }

    const url = `${baseUrl}/ilink/bot/get_bot_qrcode?bot_type=${encodeURIComponent(DEFAULT_BOT_TYPE)}`;
    let response: Response;
    try {
      response = await fetchWithTimeout(url, { method: 'GET', headers }, QR_FETCH_TIMEOUT_MS);
    } catch (error) {
      if (isAbortError(error)) {
        throw new Error(`获取微信二维码超时（${QR_FETCH_TIMEOUT_MS}ms）`);
      }
      throw error;
    }
    if (!response.ok) {
      const body = await response.text().catch(() => '');
      throw new Error(`获取微信二维码失败: ${response.status} ${response.statusText}${body ? ` (${body})` : ''}`);
    }
    const payload = parseJson<WeixinQrResponse>(await response.json());
    if (!payload?.qrcode || !payload?.qrcode_img_content) {
      throw new Error('微信二维码响应缺少必要字段');
    }
    payload.qrcode_img_content = await normalizeQrImageContentToDataUrl(payload.qrcode_img_content);
    return payload;
  }

  private async pollQrStatus(login: ActiveLogin): Promise<WeixinStatusResponse> {
    const headers: Record<string, string> = {
      'iLink-App-ClientVersion': '1',
    };
    if (login.routeTag) {
      headers.SKRouteTag = login.routeTag;
    }

    const url = `${login.baseUrl}/ilink/bot/get_qrcode_status?qrcode=${encodeURIComponent(login.qrcode)}`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), LONG_POLL_TIMEOUT_MS);
    this.externalAbortController = controller;
    try {
      const response = await fetch(url, { method: 'GET', headers, signal: controller.signal });
      if (!response.ok) {
        const body = await response.text().catch(() => '');
        throw new Error(`轮询微信登录状态失败: ${response.status} ${response.statusText}${body ? ` (${body})` : ''}`);
      }
      return parseJson<WeixinStatusResponse>(await response.json());
    } catch (error) {
      if (isAbortError(error)) {
        return { status: 'wait' };
      }
      throw error;
    } finally {
      clearTimeout(timer);
      if (this.externalAbortController === controller) {
        this.externalAbortController = null;
      }
    }
  }
}

export const weixinLoginManager = new WeixinLoginManager();
