import { beforeEach, describe, expect, it, vi } from 'vitest';

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
