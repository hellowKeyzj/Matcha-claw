import { dirname, join } from 'path';
import { createRequire } from 'module';
import { EventEmitter } from 'events';
import { existsSync, mkdirSync } from 'fs';
import { deflateSync } from 'zlib';
import { getOpenClawDir, getOpenClawResolvedDir } from '../../utils/paths';
import { fsPath } from '../../utils/fs-path';
import { cleanupWhatsAppAuthDir, resolveWhatsAppAuthDir } from './whatsapp-auth-cleanup';

const require = createRequire(import.meta.url);

const openclawPath = getOpenClawDir();
const openclawResolvedPath = getOpenClawResolvedDir();
const openclawRequire = createRequire(join(openclawResolvedPath, 'package.json'));

function resolveOpenClawPackageJson(packageName: string): string {
  const specifier = `${packageName}/package.json`;
  try {
    return openclawRequire.resolve(specifier);
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    throw new Error(
      `Failed to resolve "${packageName}" from OpenClaw context. `
      + `openclawPath=${openclawPath}, resolvedPath=${openclawResolvedPath}. ${reason}`,
      { cause: err },
    );
  }
}

const baileysPath = dirname(resolveOpenClawPackageJson('@whiskeysockets/baileys'));
const qrcodeTerminalPath = dirname(resolveOpenClawPackageJson('qrcode-terminal'));

const {
  default: makeWASocket,
  useMultiFileAuthState: initAuth,
  DisconnectReason,
  fetchLatestBaileysVersion,
} = require(baileysPath);

const QRCodeModule = require(join(qrcodeTerminalPath, 'vendor', 'QRCode', 'index.js'));
const QRErrorCorrectLevelModule = require(join(qrcodeTerminalPath, 'vendor', 'QRCode', 'QRErrorCorrectLevel.js'));

interface BaileysError extends Error {
  output?: { statusCode?: number };
}
type BaileysSocket = ReturnType<typeof makeWASocket>;
type ConnectionState = {
  connection: 'close' | 'open' | 'connecting';
  lastDisconnect?: {
    error?: Error & { output?: { statusCode?: number } };
  };
  qr?: string;
};

const QRCode = QRCodeModule;
const QRErrorCorrectLevel = QRErrorCorrectLevelModule;

function createQrMatrix(input: string) {
  const qr = new QRCode(-1, QRErrorCorrectLevel.L);
  qr.addData(input);
  qr.make();
  return qr;
}

function fillPixel(
  buf: Buffer,
  x: number,
  y: number,
  width: number,
  r: number,
  g: number,
  b: number,
  a = 255,
) {
  const idx = (y * width + x) * 4;
  buf[idx] = r;
  buf[idx + 1] = g;
  buf[idx + 2] = b;
  buf[idx + 3] = a;
}

function crcTable() {
  const table = new Uint32Array(256);
  for (let i = 0; i < 256; i += 1) {
    let c = i;
    for (let k = 0; k < 8; k += 1) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[i] = c >>> 0;
  }
  return table;
}

const CRC_TABLE = crcTable();

function crc32(buf: Buffer) {
  let crc = 0xffffffff;
  for (let i = 0; i < buf.length; i += 1) {
    crc = CRC_TABLE[(crc ^ buf[i]) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function pngChunk(type: string, data: Buffer) {
  const typeBuf = Buffer.from(type, 'ascii');
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const crc = crc32(Buffer.concat([typeBuf, data]));
  const crcBuf = Buffer.alloc(4);
  crcBuf.writeUInt32BE(crc, 0);
  return Buffer.concat([len, typeBuf, data, crcBuf]);
}

function encodePngRgba(buffer: Buffer, width: number, height: number) {
  const stride = width * 4;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let row = 0; row < height; row += 1) {
    const rawOffset = row * (stride + 1);
    raw[rawOffset] = 0;
    buffer.copy(raw, rawOffset + 1, row * stride, row * stride + stride);
  }
  const compressed = deflateSync(raw);

  const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;

  return Buffer.concat([
    signature,
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', compressed),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
}

async function renderQrPngBase64(
  input: string,
  opts: { scale?: number; marginModules?: number } = {},
): Promise<string> {
  const { scale = 6, marginModules = 4 } = opts;
  const qr = createQrMatrix(input);
  const modules = qr.getModuleCount();
  const size = (modules + marginModules * 2) * scale;

  const buf = Buffer.alloc(size * size * 4, 255);
  for (let row = 0; row < modules; row += 1) {
    for (let col = 0; col < modules; col += 1) {
      if (!qr.isDark(row, col)) {
        continue;
      }
      const startX = (col + marginModules) * scale;
      const startY = (row + marginModules) * scale;
      for (let y = 0; y < scale; y += 1) {
        const pixelY = startY + y;
        for (let x = 0; x < scale; x += 1) {
          const pixelX = startX + x;
          fillPixel(buf, pixelX, pixelY, size, 0, 0, 0, 255);
        }
      }
    }
  }

  const png = encodePngRgba(buf, size, size);
  return png.toString('base64');
}

export class WhatsAppLoginManager extends EventEmitter {
  private socket: BaileysSocket | null = null;
  private qr: string | null = null;
  private accountId: string | null = null;
  private active = false;
  private loginSucceeded = false;
  private createdAuthDirForCurrentAttempt = false;
  private currentAuthDir: string | null = null;
  private retryCount = 0;
  private maxRetries = 5;

  constructor() {
    super();
  }

  private async finishLogin(accountId: string): Promise<void> {
    if (!this.active) return;
    this.loginSucceeded = true;
    await this.stop();
    await new Promise((resolve) => setTimeout(resolve, 5000));
    this.emit('success', { accountId });
  }

  async start(accountId: string = 'default'): Promise<void> {
    if (this.active && this.accountId === accountId) {
      if (this.qr) {
        const base64 = await renderQrPngBase64(this.qr);
        this.emit('qr', { qr: base64, raw: this.qr });
      }
      return;
    }

    if (this.active) {
      await this.stop();
    }

    this.accountId = accountId;
    this.active = true;
    this.loginSucceeded = false;
    this.createdAuthDirForCurrentAttempt = false;
    this.currentAuthDir = null;
    this.qr = null;
    this.retryCount = 0;

    await this.connectToWhatsApp(accountId);
  }

  private async connectToWhatsApp(accountId: string): Promise<void> {
    if (!this.active) return;

    try {
      const authDir = resolveWhatsAppAuthDir(accountId);
      this.currentAuthDir = authDir;

      if (!existsSync(fsPath(authDir))) {
        mkdirSync(fsPath(authDir), { recursive: true });
        this.createdAuthDirForCurrentAttempt = true;
      }

      let pino: (...args: unknown[]) => Record<string, unknown>;
      try {
        const baileysRequire = createRequire(join(baileysPath, 'package.json'));
        pino = baileysRequire('pino');
      } catch {
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
      }

      const { state, saveCreds } = await initAuth(authDir);
      const { version } = await fetchLatestBaileysVersion();

      this.socket = makeWASocket({
        version,
        auth: state,
        printQRInTerminal: false,
        logger: pino({ level: 'silent' }),
        connectTimeoutMs: 60000,
      });

      let connectionOpened = false;
      let credsReceived = false;
      let credsTimeout: ReturnType<typeof setTimeout> | null = null;

      this.socket.ev.on('creds.update', async () => {
        await saveCreds();
        if (connectionOpened && !credsReceived) {
          credsReceived = true;
          if (credsTimeout) clearTimeout(credsTimeout);
          await new Promise((resolve) => setTimeout(resolve, 3000));
          await this.finishLogin(accountId);
        }
      });

      this.socket.ev.on('connection.update', async (update: ConnectionState) => {
        try {
          const { connection, lastDisconnect, qr } = update;

          if (qr) {
            this.qr = qr;
            const base64 = await renderQrPngBase64(qr);
            if (this.active) this.emit('qr', { qr: base64, raw: qr });
          }

          if (connection === 'close') {
            const error = lastDisconnect?.error as BaileysError | undefined;
            const statusCode = error?.output?.statusCode;
            const isLoggedOut = statusCode === DisconnectReason.loggedOut;
            const shouldReconnect = !isLoggedOut || this.retryCount < 2;

            if (shouldReconnect && this.active) {
              if (this.retryCount < this.maxRetries) {
                this.retryCount += 1;
                setTimeout(() => {
                  void this.connectToWhatsApp(accountId);
                }, 1000);
              } else {
                this.active = false;
                this.emit('error', 'Connection failed after multiple retries');
              }
            } else {
              this.active = false;
              if (error?.output?.statusCode === DisconnectReason.loggedOut) {
                try {
                  cleanupWhatsAppAuthDir(authDir);
                } catch (err) {
                  console.error('[WhatsAppLogin] Failed to clear auth dir:', err);
                }
              }
              if (this.socket) {
                this.socket.end(undefined);
                this.socket = null;
              }
              this.emit('error', 'Logged out');
            }
          } else if (connection === 'open') {
            this.retryCount = 0;
            connectionOpened = true;

            credsTimeout = setTimeout(async () => {
              if (!credsReceived && this.active) {
                await this.finishLogin(accountId);
              }
            }, 15000);
          }
        } catch (innerErr) {
          console.error('[WhatsAppLogin] Error in connection update:', innerErr);
        }
      });
    } catch (error) {
      if (this.active && this.retryCount < this.maxRetries) {
        this.retryCount += 1;
        setTimeout(() => {
          void this.connectToWhatsApp(accountId);
        }, 2000);
      } else {
        this.active = false;
        const msg = error instanceof Error ? error.message : String(error);
        this.emit('error', msg);
      }
    }
  }

  async stop(): Promise<void> {
    const shouldCleanupAuthDir = !this.loginSucceeded && this.createdAuthDirForCurrentAttempt;
    const authDirToCleanup = shouldCleanupAuthDir ? this.currentAuthDir : null;

    this.active = false;
    this.qr = null;
    if (this.socket) {
      try {
        this.socket.ev.removeAllListeners('connection.update');
        try {
          this.socket.ws?.close();
        } catch {
          // ignore
        }
        this.socket.end(undefined);
      } catch {
        // ignore
      }
      this.socket = null;
    }

    if (authDirToCleanup) {
      try {
        const cleanupResult = cleanupWhatsAppAuthDir(authDirToCleanup);
        if (cleanupResult.removedAuthDir) {
          console.log(`[WhatsAppLogin] Cleaned up auth dir for cancelled login: ${authDirToCleanup}`);
          if (cleanupResult.removedParentDir) {
            console.log('[WhatsAppLogin] Removed empty whatsapp credentials directory');
          }
        }
      } catch (error) {
        console.error('[WhatsAppLogin] Failed to clean up auth dir after cancel:', error);
      }
    }

    this.accountId = null;
    this.currentAuthDir = null;
    this.createdAuthDirForCurrentAttempt = false;
    this.loginSucceeded = false;
  }
}

export const whatsAppLoginManager = new WhatsAppLoginManager();
