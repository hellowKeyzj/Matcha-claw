import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const hoisted = vi.hoisted(() => ({
  readCloudAccountSessionMock: vi.fn(),
  writeCloudAccountSessionMock: vi.fn(),
  clearCloudAccountSessionMock: vi.fn(),
}));

vi.mock('../../electron/main/cloud-account/session-store', () => ({
  readCloudAccountSession: () => hoisted.readCloudAccountSessionMock(),
  writeCloudAccountSession: (...args: unknown[]) => hoisted.writeCloudAccountSessionMock(...args),
  clearCloudAccountSession: () => hoisted.clearCloudAccountSessionMock(),
}));

const localUser = {
  id: 1,
  username: 'local-user',
  email: 'local@example.com',
  avatarUrl: null,
  role: 'user',
  balance: 0,
  frozenBalance: 0,
  concurrency: 1,
  rpmLimit: 60,
  status: 'active',
  allowedGroups: null,
  balanceNotifyEnabled: false,
  balanceNotifyThreshold: null,
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
} as const;

const freshUser = {
  ...localUser,
  username: 'fresh-user',
  email: 'fresh@example.com',
  updatedAt: '2026-01-02T00:00:00.000Z',
};

const publicSettings = {
  registrationEnabled: true,
  emailVerifyEnabled: false,
  forceEmailOnThirdPartySignup: false,
  registrationEmailSuffixWhitelist: [],
  promoCodeEnabled: false,
  passwordResetEnabled: true,
  invitationCodeEnabled: false,
  turnstileEnabled: false,
  turnstileSiteKey: '',
  siteName: 'Matcha',
  siteLogo: '',
  siteSubtitle: '',
  contactInfo: '',
  docUrl: '',
  homeContent: '',
  compactHomeEnabled: false,
  paymentEnabled: false,
  linuxdoOauthEnabled: false,
  wechatOauthEnabled: false,
  oidcOauthEnabled: false,
  oidcOauthProviderName: '',
  githubOauthEnabled: false,
  googleOauthEnabled: false,
  serviceQuotaEnabled: false,
  affiliateEnabled: false,
  version: 'test',
} as const;

const localSession = {
  accessToken: 'session-access-token',
  refreshToken: 'session-refresh-token',
  expiresAt: Date.now() + 600_000,
  tokenType: 'Bearer',
  user: localUser,
};

describe('cloud account service', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    hoisted.readCloudAccountSessionMock.mockResolvedValue(localSession);
    hoisted.writeCloudAccountSessionMock.mockResolvedValue(undefined);
    hoisted.clearCloudAccountSessionMock.mockResolvedValue(undefined);
  });

  it('returns a valid local authenticated session before background profile refresh settles', async () => {
    let resolveProfile!: (value: typeof freshUser) => void;
    const fetchProfileMock = vi.fn((): Promise<typeof freshUser> => new Promise((resolve) => { resolveProfile = resolve; }));
    const { createCloudAccountService } = await import('../../electron/main/cloud-account/service');
    const service = createCloudAccountService({ fetchProfile: fetchProfileMock } as never);

    const projection = await service.getSession();

    expect(projection).toEqual({
      state: 'authenticated',
      user: localUser,
      expiresAt: localSession.expiresAt,
      tokenType: 'Bearer',
    });
    expect(fetchProfileMock).toHaveBeenCalledTimes(1);
    expect(hoisted.writeCloudAccountSessionMock).not.toHaveBeenCalled();

    resolveProfile(freshUser);
    await vi.waitFor(() => expect(hoisted.writeCloudAccountSessionMock).toHaveBeenCalledTimes(1));
    expect(hoisted.writeCloudAccountSessionMock).toHaveBeenCalledWith({ ...localSession, user: freshUser });
    await expect(service.getSession()).resolves.toEqual({
      state: 'authenticated',
      user: freshUser,
      expiresAt: localSession.expiresAt,
      tokenType: 'Bearer',
    });
    expect(fetchProfileMock).toHaveBeenCalledTimes(1);
  });

  it('prewarms public settings and session once for later calls', async () => {
    let resolvePublicSettings!: (value: typeof publicSettings) => void;
    let resolveProfile!: (value: typeof freshUser) => void;
    const fetchPublicSettingsMock = vi.fn((): Promise<typeof publicSettings> => new Promise((resolve) => { resolvePublicSettings = resolve; }));
    const fetchProfileMock = vi.fn((): Promise<typeof freshUser> => new Promise((resolve) => { resolveProfile = resolve; }));
    const { createCloudAccountService } = await import('../../electron/main/cloud-account/service');
    const service = createCloudAccountService({
      fetchPublicSettings: fetchPublicSettingsMock,
      fetchProfile: fetchProfileMock,
    } as never);

    service.prewarm();
    const settingsPromise = service.getPublicSettings();
    const sessionPromise = service.getSession();

    expect(fetchPublicSettingsMock).toHaveBeenCalledTimes(1);
    await vi.waitFor(() => expect(fetchProfileMock).toHaveBeenCalledTimes(1));

    resolvePublicSettings(publicSettings);
    await expect(settingsPromise).resolves.toBe(publicSettings);
    await expect(service.getPublicSettings()).resolves.toBe(publicSettings);
    expect(fetchPublicSettingsMock).toHaveBeenCalledTimes(1);

    await expect(sessionPromise).resolves.toEqual({
      state: 'authenticated',
      user: localUser,
      expiresAt: localSession.expiresAt,
      tokenType: 'Bearer',
    });
    resolveProfile(freshUser);
    await vi.waitFor(() => expect(hoisted.writeCloudAccountSessionMock).toHaveBeenCalledWith({ ...localSession, user: freshUser }));
    await expect(service.getSession()).resolves.toEqual({
      state: 'authenticated',
      user: freshUser,
      expiresAt: localSession.expiresAt,
      tokenType: 'Bearer',
    });
    expect(fetchProfileMock).toHaveBeenCalledTimes(1);
  });
});

describe('cloud account package client', () => {
  const originalBaseUrl = process.env.MATCHA_CLOUD_BASE_URL;

  afterEach(() => {
    process.env.MATCHA_CLOUD_BASE_URL = originalBaseUrl;
    vi.unstubAllGlobals();
  });

  it('requests package authorization lease with device key and parses device envelope there only', async () => {
    process.env.MATCHA_CLOUD_BASE_URL = 'https://cloud.test/api/v1';
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      code: 0,
      message: 'ok',
      data: {
        package_version_id: 'version-calendar',
        package_type: 'skill',
        device_envelope: { keyId: 'device-key', algorithm: 'rsa-oaep-sha256', ciphertextBase64: 'ciphertext' },
        lease_expires_at: '2099-01-01T00:00:00.000Z',
      },
    }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    const { createCloudAccountClient } = await import('../../electron/main/cloud-account/client');

    await expect(createCloudAccountClient().authorizePackage('session-access-token', {
      packageVersionId: 'version-calendar',
      packageType: 'skill',
      source: 'skills',
      devicePublicKey: 'device-public-key',
    })).resolves.toEqual({
      packageVersionId: 'version-calendar',
      packageType: 'skill',
      deviceEnvelope: { keyId: 'device-key', algorithm: 'rsa-oaep-sha256', ciphertextBase64: 'ciphertext' },
      leaseExpiresAt: '2099-01-01T00:00:00.000Z',
    });
    expect(fetchMock).toHaveBeenCalledWith('https://cloud.test/api/v1/packages/version-calendar/authorization', expect.objectContaining({
      method: 'POST',
      body: JSON.stringify({
        packageVersionId: 'version-calendar',
        packageType: 'skill',
        source: 'skills',
        devicePublicKey: 'device-public-key',
      }),
    }));
  });

  it('keeps download-record response free of device envelope', async () => {
    process.env.MATCHA_CLOUD_BASE_URL = 'https://cloud.test/api/v1';
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      code: 0,
      message: 'ok',
      data: {
        packageVersionId: 'version-calendar',
        recorded: true,
        deviceEnvelope: { keyId: 'old-device-key', algorithm: 'rsa-oaep-sha256', ciphertextBase64: 'ciphertext' },
      },
    }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    const { createCloudAccountClient } = await import('../../electron/main/cloud-account/client');

    const record = await createCloudAccountClient().recordPackageDownload('session-access-token', {
      packageVersionId: 'version-calendar',
      source: 'skills',
    });

    expect(record).toEqual({
      packageVersionId: 'version-calendar',
      recorded: true,
    });
    expect(JSON.stringify(record)).not.toContain('deviceEnvelope');
  });

  it('downloads package bytes without implicitly recording the download', async () => {
    process.env.MATCHA_CLOUD_BASE_URL = 'https://cloud.test/api/v1';
    const fetchMock = vi.fn().mockResolvedValue(new Response(new Uint8Array([1, 2, 3]), {
      status: 200,
      headers: { 'content-disposition': 'attachment; filename="calendar.matcha-skillpkg"' },
    }));
    vi.stubGlobal('fetch', fetchMock);
    const { createCloudAccountClient } = await import('../../electron/main/cloud-account/client');

    await createCloudAccountClient().downloadPackage('session-access-token', {
      packageVersionId: 'version-calendar',
      packageType: 'skill',
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0]?.[0]).toBe('https://cloud.test/api/v1/packages/version-calendar/download');
  });
});
