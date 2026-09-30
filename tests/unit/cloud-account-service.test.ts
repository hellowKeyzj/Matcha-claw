import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../electron/main/cloud-account/device-key-store', () => ({
  getCloudPackageDevicePublicKey: vi.fn().mockResolvedValue('device-public-key'),
  unwrapCloudPackageDeviceEnvelope: vi.fn().mockResolvedValue('authorization-key'),
}));

function packageTransport() {
  return {
    authorizePackage: vi.fn().mockResolvedValue({ status: 200, body: { outcome: 'accepted' } }),
    listCloudPackages: vi.fn().mockResolvedValue({ status: 200, body: { packages: [] } }),
    clearAuthorizations: vi.fn().mockResolvedValue({ status: 200, body: { outcome: 'accepted' } }),
  };
}

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
    const service = createCloudAccountService({ fetchProfile: fetchProfileMock } as never, undefined, packageTransport());

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

  it('invalidates in-flight authorization synchronously on logout and does not refill after a new login', async () => {
    let stored: typeof localSession | null = localSession;
    hoisted.readCloudAccountSessionMock.mockImplementation(async () => stored);
    hoisted.clearCloudAccountSessionMock.mockImplementation(async () => { stored = null; });
    hoisted.writeCloudAccountSessionMock.mockImplementation(async (session) => { stored = session; });
    let resolveAuthorization!: (value: unknown) => void;
    const authorizePackage = vi.fn(() => new Promise((resolve) => { resolveAuthorization = resolve; }));
    const client = {
      fetchProfile: vi.fn().mockResolvedValue(localUser), authorizePackage,
      downloadPackage: vi.fn(), logout: vi.fn().mockResolvedValue(undefined),
      login: vi.fn().mockResolvedValue({ ...localSession, accessToken: 'new-token', user: { ...localUser, id: 2 } }),
    };
    const transport = packageTransport();
    const { createCloudAccountService } = await import('../../electron/main/cloud-account/service');
    const service = createCloudAccountService(client as never, undefined, transport);
    await service.getSession();
    const installing = service.preparePackageInstall({ packageVersionId: 'v1' });
    const rejection = expect(installing).rejects.toMatchObject({ status: 409 });
    await vi.waitFor(() => expect(authorizePackage).toHaveBeenCalledTimes(1));
    await service.logout();
    await service.login({ email: 'next@example.com', password: 'password' });
    resolveAuthorization({ packageVersionId: 'v1', packageType: 'skill', leaseExpiresAt: '2099-01-01T00:00:00Z' });
    await rejection;
    expect(client.downloadPackage).not.toHaveBeenCalled();
    expect(transport.authorizePackage).not.toHaveBeenCalled();
    expect(await service.getSession()).toMatchObject({ state: 'authenticated', user: { id: 2 } });
    await service.close();
  });

  it('preserves 403 package entitlement rejection without clearing the authenticated session', async () => {
    const { createCloudAccountService } = await import('../../electron/main/cloud-account/service');
    const { CloudAccountClientError } = await import('../../electron/main/cloud-account/client');
    const client = { publishPackage: vi.fn().mockRejectedValue(new CloudAccountClientError(403, 'MATCHA_PACKAGE_VERSION_NOT_PUBLISHABLE', 'not publishable')) };
    const service = createCloudAccountService(client as never, undefined, packageTransport());
    await expect(service.publishPackage('v1')).rejects.toMatchObject({ status: 403 });
    expect(hoisted.clearCloudAccountSessionMock).not.toHaveBeenCalled();
    await service.close();
  });

  it('does not write a late token refresh after logout', async () => {
    const expiredSession = { ...localSession, expiresAt: 1 };
    let stored: typeof localSession | null = expiredSession;
    hoisted.readCloudAccountSessionMock.mockImplementation(async () => stored);
    hoisted.clearCloudAccountSessionMock.mockImplementation(async () => { stored = null; });
    hoisted.writeCloudAccountSessionMock.mockImplementation(async (session) => { stored = session; });
    let resolveRefresh!: (value: unknown) => void;
    const client = { refresh: vi.fn(() => new Promise((resolve) => { resolveRefresh = resolve; })), logout: vi.fn().mockResolvedValue(undefined) };
    const { createCloudAccountService } = await import('../../electron/main/cloud-account/service');
    const service = createCloudAccountService(client as never, undefined, packageTransport());
    const session = service.getSession();
    const rejected = expect(session).rejects.toMatchObject({ status: 409 });
    await vi.waitFor(() => expect(client.refresh).toHaveBeenCalledTimes(1));
    await service.logout();
    resolveRefresh({ accessToken: 'late-token', refreshToken: 'late-refresh', expiresAt: Date.now() + 600_000, tokenType: 'Bearer' });
    await rejected;
    expect(stored).toBeNull();
    expect(hoisted.writeCloudAccountSessionMock).not.toHaveBeenCalled();
    expect(await service.getSession()).toEqual({ state: 'anonymous' });
    await service.close();
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
    } as never, undefined, packageTransport());

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

  it('publishes through existing cloud endpoint and preserves string rejection codes', async () => {
    process.env.MATCHA_CLOUD_BASE_URL = 'https://cloud.test/api/v1';
    const version = { packageId: 'pkg', packageVersionId: 'v1', name: 'calendar', packageType: 'skill', version: '1', status: 'published', downloadable: true };
    const fetchMock = vi.fn().mockResolvedValueOnce(new Response(JSON.stringify({ code: 0, data: version }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ code: 'MATCHA_PACKAGE_CLOUD_ENVELOPE_REQUIRED', message: 'cloud envelope required' }), { status: 403 }));
    vi.stubGlobal('fetch', fetchMock);
    const { createCloudAccountClient } = await import('../../electron/main/cloud-account/client');
    const client = createCloudAccountClient();
    await expect(client.publishPackage('token', 'v1')).resolves.toEqual(version);
    expect(fetchMock).toHaveBeenCalledWith('https://cloud.test/api/v1/packages/v1/publish', expect.objectContaining({ method: 'POST', headers: expect.objectContaining({ Authorization: 'Bearer token' }) }));
    await expect(client.publishPackage('token', 'v1')).rejects.toMatchObject({ status: 403, code: 'MATCHA_PACKAGE_CLOUD_ENVELOPE_REQUIRED' });
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
