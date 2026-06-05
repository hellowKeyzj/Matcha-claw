import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { OpenClawChannelLoginSessionService } from '../../runtime-host/application/adapters/openclaw/projections/openclaw-channel-login-session-service';
import { OpenClawWeixinAccountStoreWorkflow } from '../../runtime-host/application/adapters/openclaw/workflows/openclaw-channel/openclaw-weixin-account-store-workflow';
import { createTestRuntimeFileSystem } from './helpers/runtime-file-system';
import { createTestRuntimeLogger } from './helpers/runtime-logger';
import { createTestOpenClawEnvironmentRepository } from './helpers/runtime-system-environment';

async function waitForCondition(
  predicate: () => boolean | Promise<boolean>,
  timeoutMs = 3000,
  intervalMs = 20,
): Promise<void> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    if (await predicate()) {
      return;
    }
    await new Promise<void>((resolve) => setTimeout(resolve, intervalMs));
  }
  throw new Error('waitForCondition timeout');
}

describe('OpenClawChannelLoginSessionService Weixin login', () => {
  let tempDir = '';
  let previousConfigDir: string | undefined;
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'matchaclaw-weixin-login-'));
    previousConfigDir = process.env.OPENCLAW_CONFIG_DIR;
    process.env.OPENCLAW_CONFIG_DIR = tempDir;
    originalFetch = globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    if (previousConfigDir === undefined) {
      delete process.env.OPENCLAW_CONFIG_DIR;
    } else {
      process.env.OPENCLAW_CONFIG_DIR = previousConfigDir;
    }
    if (tempDir) {
      rmSync(tempDir, { recursive: true, force: true });
    }
    vi.restoreAllMocks();
  });

  it('同一微信用户再次扫码后只保留最新 bot 账号并清理旧账号文件', async () => {
    const weixinStateDir = join(tempDir, 'openclaw-weixin');
    const accountsDir = join(weixinStateDir, 'accounts');
    const staleAccountId = 'old-im-bot';
    const staleUserId = 'user-1@im.wechat';
    mkdirSync(accountsDir, { recursive: true });
    writeFileSync(join(weixinStateDir, 'accounts.json'), JSON.stringify([staleAccountId], null, 2), 'utf8');
    writeFileSync(join(accountsDir, `${staleAccountId}.json`), JSON.stringify({
      token: 'old@im.bot:token',
      baseUrl: 'https://ilinkai.weixin.qq.com',
      savedAt: '2026-04-20T00:00:00.000Z',
      userId: staleUserId,
    }, null, 2), 'utf8');
    writeFileSync(join(accountsDir, `${staleAccountId}.sync.json`), '{"get_updates_buf":"old"}', 'utf8');
    writeFileSync(join(accountsDir, `${staleAccountId}.context-tokens.json`), '{"user":"token"}', 'utf8');

    const saveChannelConfig = vi.fn(async () => {});
    const restartGateway = vi.fn(async () => {});
    const events: Array<{ eventName: string; payload: unknown }> = [];
    globalThis.fetch = vi.fn(async (url: string | URL | Request) => {
      const textUrl = String(url);
      if (textUrl.includes('/ilink/bot/get_bot_qrcode')) {
        return new Response(JSON.stringify({
          qrcode: 'qr-token',
          qrcode_img_content: 'data:image/png;base64,AAAA',
        }), { status: 200 });
      }
      if (textUrl.includes('/ilink/bot/get_qrcode_status')) {
        return new Response(JSON.stringify({
          status: 'confirmed',
          bot_token: 'new@im.bot:token',
          ilink_bot_id: 'new@im.bot',
          ilink_user_id: staleUserId,
          baseurl: 'https://ilinkai.weixin.qq.com',
        }), { status: 200 });
      }
      throw new Error(`unexpected fetch ${textUrl}`);
    }) as typeof globalThis.fetch;

    const fileSystem = createTestRuntimeFileSystem();
    const runtime = {
      getEnv: (name: string) => createTestOpenClawEnvironmentRepository().getEnv(name),
      getRuntimeDataRootDir: () => createTestOpenClawEnvironmentRepository().getOpenClawConfigDir(),
      resolveRuntimeModulePath: (specifier: string) => createTestOpenClawEnvironmentRepository().getOpenClawDirPath() + `/node_modules/${specifier}`,
    };
    const service = new OpenClawChannelLoginSessionService({
      fileSystem,
      runtime,
      weixinAccounts: new OpenClawWeixinAccountStoreWorkflow({ fileSystem, runtime }),
      idGenerator: { randomId: () => 'requested-account' },
      timer: { sleep: async () => {} },
      logger: createTestRuntimeLogger(),
      emitGatewayEvent: (eventName, payload) => {
        events.push({ eventName, payload });
      },
      saveChannelConfig,
      restartGateway,
    });

    await service.start({ channelType: 'openclaw-weixin', accountId: 'requested-account' });

    await waitForCondition(() => saveChannelConfig.mock.calls.length === 1);

    const newAccountId = 'new-im-bot';
    expect(JSON.parse(readFileSync(join(weixinStateDir, 'accounts.json'), 'utf8'))).toEqual([newAccountId]);
    expect(existsSync(join(accountsDir, `${newAccountId}.json`))).toBe(true);
    expect(existsSync(join(accountsDir, `${staleAccountId}.json`))).toBe(false);
    expect(existsSync(join(accountsDir, `${staleAccountId}.sync.json`))).toBe(false);
    expect(existsSync(join(accountsDir, `${staleAccountId}.context-tokens.json`))).toBe(false);
    expect(saveChannelConfig).toHaveBeenCalledWith({
      channelType: 'openclaw-weixin',
      accountId: newAccountId,
      config: { enabled: true },
      enabled: true,
      staleAccountIds: [staleAccountId],
    });
    expect(restartGateway).toHaveBeenCalledOnce();
    expect(events.some((event) => event.eventName === 'gateway:channel-status')).toBe(true);
  });
});
