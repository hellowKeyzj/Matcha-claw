import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { deflateSync } from 'node:zlib';
import type { RuntimeFileSystemPort, RuntimeIdGeneratorPort, RuntimeTimerPort } from '../../../common/runtime-ports';
import type { ChannelLoginSessionHandlerPort } from '../../../channels/channel-login-session-service';
import type { OpenClawWeixinAccountStoreWorkflow } from '../workflows/openclaw-channel/openclaw-weixin-account-store-workflow';
import type { RuntimeHostLogger } from '../../../../shared/logger';

type QrCodeModule = {
  toDataURL(input: string, options: { errorCorrectionLevel: string; margin: number; width: number }): Promise<string>;
};

type ChannelLoginEventName =
  | 'channel:whatsapp-qr'
  | 'channel:whatsapp-success'
  | 'channel:whatsapp-error'
  | 'channel:weixin-qr'
  | 'channel:weixin-success'
  | 'channel:weixin-error';

type EmitGatewayEvent = (eventName: 'gateway:channel-status', payload: unknown) => void;

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

type WeixinActiveLogin = {
  sessionKey: string;
  accountId: string;
  baseUrl: string;
  routeTag?: string;
  qrcode: string;
  qrcodeUrl: string;
  startedAt: number;
  refreshCount: number;
};

type BaileysSocket = {
  ev: {
    on: (event: string, listener: (...args: unknown[]) => void) => void;
    removeAllListeners: (event?: string) => void;
  };
  ws?: { close?: () => void };
  end: (arg?: unknown) => void;
};

type WhatsAppRuntimeDeps = {
  readonly baileysPath: string;
  readonly makeWASocket: (...args: unknown[]) => BaileysSocket;
  readonly initAuth: (authDir: string) => Promise<{
    state: unknown;
    saveCreds: () => Promise<void>;
  }>;
  readonly DisconnectReason: { loggedOut?: number };
  readonly fetchLatestBaileysVersion: () => Promise<{ version: unknown }>;
  readonly QRCode: new (typeNumber: number, errorCorrectLevel: unknown) => {
    addData: (input: string) => void;
    make: () => void;
    getModuleCount: () => number;
    isDark: (row: number, col: number) => boolean;
  };
  readonly QRErrorCorrectLevel: { L: unknown };
};

export interface ChannelLoginRuntimePort {
  getEnv(name: string): string | undefined;
  getRuntimeDataRootDir(): string;
  resolveRuntimeModulePath(specifier: string): string;
}

type ChannelLoginSessionDeps = {
  readonly fileSystem: RuntimeFileSystemPort;
  readonly runtime: ChannelLoginRuntimePort;
  readonly weixinAccounts: Pick<OpenClawWeixinAccountStoreWorkflow, 'saveAccount'>;
  readonly idGenerator: Pick<RuntimeIdGeneratorPort, 'randomId'>;
  readonly timer: RuntimeTimerPort;
  readonly logger: RuntimeHostLogger;
  readonly emitGatewayEvent: EmitGatewayEvent;
  readonly saveChannelConfig: (payload: unknown) => Promise<void>;
  readonly restartGateway: () => Promise<void>;
};

const DEFAULT_BASE_URL = 'https://ilinkai.weixin.qq.com';
const DEFAULT_BOT_TYPE = '3';
const LOGIN_TIMEOUT_MS = 480_000;
const LONG_POLL_TIMEOUT_MS = 35_000;
const QR_FETCH_TIMEOUT_MS = 8_000;
const MAX_QR_REFRESH_COUNT = 3;
const POLL_RETRY_DELAY_MS = 1000;

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function normalizeSessionKey(value: unknown): string | undefined {
  if (typeof value !== 'string') {
    return undefined;
  }
  const normalized = value.trim();
  return normalized || undefined;
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

function normalizeAccountId(input: string): string {
  const normalized = input
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '-')
    .replace(/^-+/, '')
    .replace(/-+$/, '')
    .slice(0, 64);
  return normalized || 'default';
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
  const require = createRequire(__filename);
  const QRCode = require('qrcode') as QrCodeModule;
  return await QRCode.toDataURL(value, {
    errorCorrectionLevel: 'M',
    margin: 1,
    width: 360,
  });
}

function crcTable() {
  const table = new Uint32Array(256);
  for (let index = 0; index < 256; index += 1) {
    let value = index;
    for (let bit = 0; bit < 8; bit += 1) {
      value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
    }
    table[index] = value >>> 0;
  }
  return table;
}

const CRC_TABLE = crcTable();

function crc32(buffer: Buffer) {
  let crc = 0xffffffff;
  for (let index = 0; index < buffer.length; index += 1) {
    crc = CRC_TABLE[(crc ^ buffer[index]) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function pngChunk(type: string, data: Buffer) {
  const typeBuffer = Buffer.from(type, 'ascii');
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length, 0);
  const crcBuffer = Buffer.alloc(4);
  crcBuffer.writeUInt32BE(crc32(Buffer.concat([typeBuffer, data])), 0);
  return Buffer.concat([length, typeBuffer, data, crcBuffer]);
}

function fillPixel(buffer: Buffer, x: number, y: number, width: number): void {
  const offset = (y * width + x) * 4;
  buffer[offset] = 0;
  buffer[offset + 1] = 0;
  buffer[offset + 2] = 0;
  buffer[offset + 3] = 255;
}

function encodePngRgba(buffer: Buffer, width: number, height: number) {
  const stride = width * 4;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let row = 0; row < height; row += 1) {
    const rawOffset = row * (stride + 1);
    raw[rawOffset] = 0;
    buffer.copy(raw, rawOffset + 1, row * stride, row * stride + stride);
  }
  const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8;
  header[9] = 6;
  return Buffer.concat([
    signature,
    pngChunk('IHDR', header),
    pngChunk('IDAT', deflateSync(raw)),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
}

export class OpenClawChannelLoginSessionService implements ChannelLoginSessionHandlerPort {
  private weixinActiveLogin: WeixinActiveLogin | null = null;
  private weixinRunning = false;
  private weixinPollTask: Promise<void> | null = null;
  private weixinAbortController: AbortController | null = null;
  private whatsappSocket: BaileysSocket | null = null;
  private whatsappQr: string | null = null;
  private whatsappAccountId: string | null = null;
  private whatsappActive = false;
  private whatsappLoginSucceeded = false;
  private whatsappCreatedAuthDirForCurrentAttempt = false;
  private whatsappCurrentAuthDir: string | null = null;
  private whatsappRetryCount = 0;
  private whatsappRuntimeDeps: WhatsAppRuntimeDeps | null = null;
  private readonly pendingWeixinPersists = new Map<string, Record<string, unknown>>();
  private readonly pendingWhatsAppAccounts = new Set<string>();

  constructor(private readonly deps: ChannelLoginSessionDeps) {}

  async start(input: { channelType: string; accountId?: string; config?: Record<string, unknown> }): Promise<{ queued: true; sessionKey: string }> {
    const accountId = normalizeSessionKey(input.accountId) ?? 'default';
    if (input.channelType === 'whatsapp') {
      this.pendingWhatsAppAccounts.add(accountId);
      this.startWhatsAppInBackground(accountId);
      return { queued: true, sessionKey: accountId };
    }
    if (input.channelType === 'openclaw-weixin') {
      const config = {
        ...(isRecord(input.config) ? input.config : {}),
        enabled: true,
      };
      this.pendingWeixinPersists.set(accountId, config);
      this.startWeixinInBackground({
        accountId,
        baseUrl: typeof config.baseUrl === 'string' ? config.baseUrl : undefined,
        routeTag: typeof config.routeTag === 'string' ? config.routeTag : undefined,
      });
      return { queued: true, sessionKey: accountId };
    }
    throw new Error(`Unsupported channel session start: ${input.channelType}`);
  }

  async cancel(channelType: string): Promise<void> {
    if (channelType === 'whatsapp') {
      this.pendingWhatsAppAccounts.clear();
      await this.stopWhatsApp();
      return;
    }
    if (channelType === 'openclaw-weixin') {
      await this.stopWeixin();
      this.pendingWeixinPersists.clear();
      return;
    }
    throw new Error(`Unsupported channel session cancel: ${channelType}`);
  }

  private emitChannelEvent(eventName: ChannelLoginEventName, payload: unknown): void {
    this.deps.emitGatewayEvent('gateway:channel-status', {
      eventName,
      payload,
      updatedAt: Date.now(),
    });
  }

  private async commitWeixinConfigAfterLoginSuccess(data: unknown): Promise<void> {
    const payload = isRecord(data) ? data : {};
    const bySession = normalizeSessionKey(payload.sessionKey);
    const byRequested = normalizeSessionKey(payload.requestedAccountId);
    const key = bySession ?? byRequested ?? (this.pendingWeixinPersists.size === 1 ? [...this.pendingWeixinPersists.keys()][0] : undefined);
    if (!key) {
      return;
    }
    const pending = this.pendingWeixinPersists.get(key);
    if (!pending) {
      return;
    }
    this.pendingWeixinPersists.delete(key);
    const accountId = normalizeSessionKey(payload.accountId);
    await this.deps.saveChannelConfig({
      channelType: 'openclaw-weixin',
      ...(accountId ? { accountId } : {}),
      config: { ...pending, enabled: true },
      enabled: true,
      ...(Array.isArray(payload.staleAccountIds) ? { staleAccountIds: payload.staleAccountIds } : {}),
    });
    await this.deps.restartGateway();
  }

  private async commitWhatsAppConfigAfterLoginSuccess(data: unknown): Promise<void> {
    const payload = isRecord(data) ? data : {};
    const accountId = normalizeSessionKey(payload.accountId)
      ?? (this.pendingWhatsAppAccounts.size === 1 ? [...this.pendingWhatsAppAccounts][0] : undefined);
    if (!accountId || !this.pendingWhatsAppAccounts.has(accountId)) {
      return;
    }
    this.pendingWhatsAppAccounts.delete(accountId);
    await this.deps.saveChannelConfig({
      channelType: 'whatsapp',
      accountId,
      config: { enabled: true },
      enabled: true,
    });
    await this.deps.restartGateway();
  }

  private startWeixinInBackground(options: { accountId?: string; baseUrl?: string; routeTag?: string; timeoutMs?: number }): void {
    void this.startWeixin(options).catch((error) => {
      this.weixinRunning = false;
      this.weixinActiveLogin = null;
      this.emitChannelEvent('channel:weixin-error', error instanceof Error ? error.message : String(error));
    });
  }

  private startWhatsAppInBackground(accountId: string): void {
    void this.startWhatsApp(accountId).catch((error) => {
      this.whatsappActive = false;
      this.emitChannelEvent('channel:whatsapp-error', error instanceof Error ? error.message : String(error));
    });
  }

  private async startWeixin(options: { accountId?: string; baseUrl?: string; routeTag?: string; timeoutMs?: number }): Promise<void> {
    const accountId = options.accountId?.trim() || this.deps.idGenerator.randomId();
    const baseUrl = normalizeBaseUrl(options.baseUrl);
    const routeTag = normalizeRouteTag(options.routeTag);
    const timeoutMs = typeof options.timeoutMs === 'number' && options.timeoutMs > 0
      ? options.timeoutMs
      : LOGIN_TIMEOUT_MS;
    await this.stopWeixin();
    this.weixinRunning = true;

    const qrResult = await this.fetchWeixinQrCode(baseUrl, routeTag);
    this.weixinActiveLogin = {
      sessionKey: accountId,
      accountId,
      baseUrl,
      routeTag,
      qrcode: qrResult.qrcode,
      qrcodeUrl: qrResult.qrcode_img_content,
      startedAt: Date.now(),
      refreshCount: 1,
    };
    this.emitChannelEvent('channel:weixin-qr', {
      sessionKey: accountId,
      accountId,
      qrDataUrl: qrResult.qrcode_img_content,
      raw: qrResult.qrcode,
    });
    this.weixinPollTask = this.pollWeixinUntilDone(timeoutMs);
  }

  private async stopWeixin(): Promise<void> {
    this.weixinRunning = false;
    this.weixinActiveLogin = null;
    if (this.weixinAbortController) {
      this.weixinAbortController.abort();
      this.weixinAbortController = null;
    }
    if (this.weixinPollTask) {
      try {
        await this.weixinPollTask;
      } catch {
        // ignored
      } finally {
        this.weixinPollTask = null;
      }
    }
  }

  private async pollWeixinUntilDone(timeoutMs: number): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (this.weixinRunning && this.weixinActiveLogin && Date.now() < deadline) {
      const current = this.weixinActiveLogin;
      try {
        const status = await this.pollWeixinQrStatus(current);
        if (!this.weixinRunning || !this.weixinActiveLogin) {
          return;
        }
        if (status.status === 'wait' || status.status === 'scaned') {
          await this.deps.timer.sleep(POLL_RETRY_DELAY_MS);
          continue;
        }
        if (status.status === 'expired') {
          if (current.refreshCount >= MAX_QR_REFRESH_COUNT) {
            this.weixinRunning = false;
            this.weixinActiveLogin = null;
            this.emitChannelEvent('channel:weixin-error', '二维码多次过期，请重新发起登录。');
            return;
          }
          const refreshed = await this.fetchWeixinQrCode(current.baseUrl, current.routeTag);
          this.weixinActiveLogin = {
            ...current,
            qrcode: refreshed.qrcode,
            qrcodeUrl: refreshed.qrcode_img_content,
            startedAt: Date.now(),
            refreshCount: current.refreshCount + 1,
          };
          this.emitChannelEvent('channel:weixin-qr', {
            sessionKey: current.sessionKey,
            accountId: current.accountId,
            qrDataUrl: refreshed.qrcode_img_content,
            raw: refreshed.qrcode,
          });
          continue;
        }
        if (status.status === 'confirmed') {
          if (!status.ilink_bot_id || !status.bot_token) {
            this.weixinRunning = false;
            this.weixinActiveLogin = null;
            this.emitChannelEvent('channel:weixin-error', '扫码已确认，但登录凭据返回不完整。');
            return;
          }
          const normalizedId = normalizeAccountId(status.ilink_bot_id);
          const persistedBaseUrl = normalizeBaseUrl(status.baseurl || current.baseUrl);
          const persisted = await this.deps.weixinAccounts.saveAccount({
            normalizedAccountId: normalizedId,
            token: status.bot_token,
            baseUrl: persistedBaseUrl,
            userId: status.ilink_user_id,
          });
          const payload = {
            sessionKey: current.sessionKey,
            requestedAccountId: current.accountId,
            accountId: normalizedId,
            userId: status.ilink_user_id,
            baseUrl: persistedBaseUrl,
            staleAccountIds: persisted.staleAccountIds,
          };
          this.weixinRunning = false;
          this.weixinActiveLogin = null;
          await this.commitWeixinConfigAfterLoginSuccess(payload);
          this.emitChannelEvent('channel:weixin-success', payload);
          return;
        }
      } catch (error) {
        if (isAbortError(error)) {
          return;
        }
        this.weixinRunning = false;
        this.weixinActiveLogin = null;
        this.emitChannelEvent('channel:weixin-error', error instanceof Error ? error.message : String(error));
        return;
      }
      await this.deps.timer.sleep(POLL_RETRY_DELAY_MS);
    }
    if (this.weixinRunning) {
      this.weixinRunning = false;
      this.weixinActiveLogin = null;
      this.emitChannelEvent('channel:weixin-error', '登录超时，请重试。');
    }
  }

  private async fetchWeixinQrCode(baseUrl: string, routeTag?: string): Promise<WeixinQrResponse> {
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
        throw new Error(`获取微信二维码超时（${QR_FETCH_TIMEOUT_MS}ms）`, { cause: error });
      }
      throw error;
    }
    if (!response.ok) {
      const body = await response.text().catch(() => '');
      throw new Error(`获取微信二维码失败: ${response.status} ${response.statusText}${body ? ` (${body})` : ''}`);
    }
    const payload = await response.json() as WeixinQrResponse;
    if (!payload?.qrcode || !payload?.qrcode_img_content) {
      throw new Error('微信二维码响应缺少必要字段');
    }
    payload.qrcode_img_content = await normalizeQrImageContentToDataUrl(
      payload.qrcode_img_content,
    );
    return payload;
  }

  private async pollWeixinQrStatus(login: WeixinActiveLogin): Promise<WeixinStatusResponse> {
    const headers: Record<string, string> = {
      'iLink-App-ClientVersion': '1',
    };
    if (login.routeTag) {
      headers.SKRouteTag = login.routeTag;
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), LONG_POLL_TIMEOUT_MS);
    this.weixinAbortController = controller;
    try {
      const response = await fetch(`${login.baseUrl}/ilink/bot/get_qrcode_status?qrcode=${encodeURIComponent(login.qrcode)}`, {
        method: 'GET',
        headers,
        signal: controller.signal,
      });
      if (!response.ok) {
        const body = await response.text().catch(() => '');
        throw new Error(`轮询微信登录状态失败: ${response.status} ${response.statusText}${body ? ` (${body})` : ''}`);
      }
      return await response.json() as WeixinStatusResponse;
    } catch (error) {
      if (isAbortError(error)) {
        return { status: 'wait' };
      }
      throw error;
    } finally {
      clearTimeout(timer);
      if (this.weixinAbortController === controller) {
        this.weixinAbortController = null;
      }
    }
  }

  private resolveWhatsAppAuthDir(accountId: string): string {
    return join(this.deps.runtime.getRuntimeDataRootDir(), 'credentials', 'whatsapp', accountId.trim() || 'default');
  }

  private async cleanupWhatsAppAuthDir(authDir: string): Promise<void> {
    if (await this.deps.fileSystem.exists(authDir)) {
      await this.deps.fileSystem.removeDirectory(authDir);
    }
  }

  private loadWhatsAppRuntimeDeps(): WhatsAppRuntimeDeps {
    if (this.whatsappRuntimeDeps) {
      return this.whatsappRuntimeDeps;
    }
    const require = createRequire(__filename);
    const baileysPath = dirname(this.deps.runtime.resolveRuntimeModulePath('@whiskeysockets/baileys/package.json'));
    const qrCodePath = this.deps.runtime.resolveRuntimeModulePath('qrcode-terminal/vendor/QRCode/index.js');
    const qrErrorCorrectLevelPath = this.deps.runtime.resolveRuntimeModulePath('qrcode-terminal/vendor/QRCode/QRErrorCorrectLevel.js');
    const baileysModule = require(baileysPath) as {
      default?: WhatsAppRuntimeDeps['makeWASocket'];
      useMultiFileAuthState?: WhatsAppRuntimeDeps['initAuth'];
      DisconnectReason?: WhatsAppRuntimeDeps['DisconnectReason'];
      fetchLatestBaileysVersion?: WhatsAppRuntimeDeps['fetchLatestBaileysVersion'];
    };
    const QRCode = require(qrCodePath) as WhatsAppRuntimeDeps['QRCode'];
    const QRErrorCorrectLevel = require(qrErrorCorrectLevelPath) as WhatsAppRuntimeDeps['QRErrorCorrectLevel'];
    if (
      typeof baileysModule.default !== 'function'
      || typeof baileysModule.useMultiFileAuthState !== 'function'
      || !baileysModule.DisconnectReason
      || typeof baileysModule.fetchLatestBaileysVersion !== 'function'
    ) {
      throw new Error('Invalid Baileys runtime exports from channel runtime context');
    }
    this.whatsappRuntimeDeps = {
      baileysPath,
      makeWASocket: baileysModule.default,
      initAuth: baileysModule.useMultiFileAuthState,
      DisconnectReason: baileysModule.DisconnectReason,
      fetchLatestBaileysVersion: baileysModule.fetchLatestBaileysVersion,
      QRCode,
      QRErrorCorrectLevel,
    };
    return this.whatsappRuntimeDeps;
  }

  private createQrMatrix(input: string) {
    const { QRCode, QRErrorCorrectLevel } = this.loadWhatsAppRuntimeDeps();
    const qr = new QRCode(-1, QRErrorCorrectLevel.L);
    qr.addData(input);
    qr.make();
    return qr;
  }

  private async renderQrPngBase64(input: string): Promise<string> {
    const scale = 6;
    const marginModules = 4;
    const qr = this.createQrMatrix(input);
    const modules = qr.getModuleCount();
    const size = (modules + marginModules * 2) * scale;
    const buffer = Buffer.alloc(size * size * 4, 255);
    for (let row = 0; row < modules; row += 1) {
      for (let col = 0; col < modules; col += 1) {
        if (!qr.isDark(row, col)) {
          continue;
        }
        const startX = (col + marginModules) * scale;
        const startY = (row + marginModules) * scale;
        for (let y = 0; y < scale; y += 1) {
          for (let x = 0; x < scale; x += 1) {
            fillPixel(buffer, startX + x, startY + y, size);
          }
        }
      }
    }
    return encodePngRgba(buffer, size, size).toString('base64');
  }

  private async finishWhatsAppLogin(accountId: string): Promise<void> {
    if (!this.whatsappActive) {
      return;
    }
    this.whatsappLoginSucceeded = true;
    await this.stopWhatsApp();
    await this.deps.timer.sleep(5000);
    const payload = { accountId };
    await this.commitWhatsAppConfigAfterLoginSuccess(payload);
    this.emitChannelEvent('channel:whatsapp-success', payload);
  }

  private async startWhatsApp(accountId = 'default'): Promise<void> {
    if (this.whatsappActive && this.whatsappAccountId === accountId) {
      if (this.whatsappQr) {
        this.emitChannelEvent('channel:whatsapp-qr', {
          qr: await this.renderQrPngBase64(this.whatsappQr),
          raw: this.whatsappQr,
        });
      }
      return;
    }
    if (this.whatsappActive) {
      await this.stopWhatsApp();
    }
    this.whatsappAccountId = accountId;
    this.whatsappActive = true;
    this.whatsappLoginSucceeded = false;
    this.whatsappCreatedAuthDirForCurrentAttempt = false;
    this.whatsappCurrentAuthDir = null;
    this.whatsappQr = null;
    this.whatsappRetryCount = 0;
    await this.connectToWhatsApp(accountId);
  }

  private async connectToWhatsApp(accountId: string): Promise<void> {
    if (!this.whatsappActive) {
      return;
    }
    try {
      const {
        baileysPath,
        makeWASocket,
        initAuth,
        DisconnectReason,
        fetchLatestBaileysVersion,
      } = this.loadWhatsAppRuntimeDeps();
      const authDir = this.resolveWhatsAppAuthDir(accountId);
      this.whatsappCurrentAuthDir = authDir;
      if (!(await this.deps.fileSystem.exists(authDir))) {
        await this.deps.fileSystem.ensureDirectory(authDir);
        this.whatsappCreatedAuthDirForCurrentAttempt = true;
      }
      const require = createRequire(join(baileysPath, 'package.json'));
      let pino: (...args: unknown[]) => Record<string, unknown>;
      try {
        pino = require('pino');
      } catch {
        pino = () => ({
          trace: () => {},
          debug: () => {},
          info: () => {},
          warn: () => {},
          error: () => {},
          fatal: () => {},
          child: () => pino(),
        });
      }
      const { state, saveCreds } = await initAuth(authDir);
      if (!this.whatsappActive || this.whatsappAccountId !== accountId) {
        return;
      }
      const { version } = await fetchLatestBaileysVersion();
      if (!this.whatsappActive || this.whatsappAccountId !== accountId) {
        return;
      }
      this.whatsappSocket = makeWASocket({
        version,
        auth: state,
        printQRInTerminal: false,
        logger: pino({ level: 'silent' }),
        connectTimeoutMs: 60000,
      });

      let connectionOpened = false;
      let credsReceived = false;
      let credsTimeout: ReturnType<typeof setTimeout> | null = null;
      this.whatsappSocket.ev.on('creds.update', async () => {
        await saveCreds();
        if (connectionOpened && !credsReceived) {
          credsReceived = true;
          if (credsTimeout) {
            clearTimeout(credsTimeout);
          }
          await this.deps.timer.sleep(3000);
          await this.finishWhatsAppLogin(accountId);
        }
      });
      this.whatsappSocket.ev.on('connection.update', async (update: unknown) => {
        const record = isRecord(update) ? update : {};
        const connection = record.connection;
        const qr = typeof record.qr === 'string' ? record.qr : '';
        if (qr) {
          this.whatsappQr = qr;
          this.emitChannelEvent('channel:whatsapp-qr', {
            qr: await this.renderQrPngBase64(qr),
            raw: qr,
          });
        }
        if (connection === 'open') {
          this.whatsappRetryCount = 0;
          connectionOpened = true;
          credsTimeout = setTimeout(() => {
            if (!credsReceived && this.whatsappActive) {
              void this.finishWhatsAppLogin(accountId);
            }
          }, 15000);
          return;
        }
        if (connection !== 'close') {
          return;
        }
        const lastDisconnect = isRecord(record.lastDisconnect) ? record.lastDisconnect : {};
        const error = lastDisconnect.error as { output?: { statusCode?: number } } | undefined;
        const statusCode = error?.output?.statusCode;
        const isLoggedOut = statusCode === DisconnectReason.loggedOut;
        const shouldReconnect = !isLoggedOut || this.whatsappRetryCount < 2;
        if (shouldReconnect && this.whatsappActive && this.whatsappRetryCount < 5) {
          this.whatsappRetryCount += 1;
          setTimeout(() => {
            void this.connectToWhatsApp(accountId);
          }, 1000);
          return;
        }
        this.whatsappActive = false;
        if (isLoggedOut) {
          await this.cleanupWhatsAppAuthDir(authDir);
        }
        this.whatsappSocket?.end(undefined);
        this.whatsappSocket = null;
        this.emitChannelEvent('channel:whatsapp-error', isLoggedOut ? 'Logged out' : 'Connection failed after multiple retries');
      });
    } catch (error) {
      if (this.whatsappActive && this.whatsappRetryCount < 5) {
        this.whatsappRetryCount += 1;
        setTimeout(() => {
          void this.connectToWhatsApp(accountId);
        }, 2000);
        return;
      }
      this.whatsappActive = false;
      this.emitChannelEvent('channel:whatsapp-error', error instanceof Error ? error.message : String(error));
    }
  }

  private async stopWhatsApp(): Promise<void> {
    const shouldCleanupAuthDir = !this.whatsappLoginSucceeded && this.whatsappCreatedAuthDirForCurrentAttempt;
    const authDirToCleanup = shouldCleanupAuthDir ? this.whatsappCurrentAuthDir : null;
    this.whatsappActive = false;
    this.whatsappQr = null;
    if (this.whatsappSocket) {
      try {
        this.whatsappSocket.ev.removeAllListeners('connection.update');
        this.whatsappSocket.ws?.close?.();
        this.whatsappSocket.end(undefined);
      } catch {
        // ignore
      }
      this.whatsappSocket = null;
    }
    if (authDirToCleanup) {
      await this.cleanupWhatsAppAuthDir(authDirToCleanup).catch((error) => {
        this.deps.logger.warn(`Failed to clean up whatsapp auth dir: ${String(error)}`);
      });
    }
    this.whatsappAccountId = null;
    this.whatsappCurrentAuthDir = null;
    this.whatsappCreatedAuthDirForCurrentAttempt = false;
    this.whatsappLoginSucceeded = false;
  }
}
