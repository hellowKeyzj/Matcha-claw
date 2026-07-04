import type { RuntimeIdGeneratorPort, RuntimeSystemEnvironmentPort } from '../common/runtime-ports';
import type { SettingsRepository } from '../settings/store';

const TEAM_WEBHOOK_TOKEN_SETTING_KEY = 'teamWebhookToken';
const TEAM_WEBHOOK_TOKEN_ENV = 'MATCHACLAW_TEAM_WEBHOOK_TOKEN';

export type TeamRuntimeWebhookTokenSource = 'environment' | 'settings';

export interface TeamRuntimeWebhookAuthProjection {
  success: true;
  token: string;
  source: TeamRuntimeWebhookTokenSource;
  headerName: 'x-matchaclaw-webhook-token';
  authorizationScheme: 'Bearer';
}

export interface TeamRuntimeWebhookPublicAuthProjection {
  success: true;
  enabled: true;
  source: TeamRuntimeWebhookTokenSource;
  headerName: 'x-matchaclaw-webhook-token';
  authorizationScheme: 'Bearer';
  maskedToken: string;
  copySupported: false;
}

export interface TeamRuntimeWebhookAuthServiceDeps {
  readonly environment: Pick<RuntimeSystemEnvironmentPort, 'getEnv'>;
  readonly settingsRepository: Pick<SettingsRepository, 'getAll' | 'setValue'>;
  readonly idGenerator: Pick<RuntimeIdGeneratorPort, 'randomHex'>;
}

export class TeamRuntimeWebhookAuthService {
  private cachedToken: TeamRuntimeWebhookAuthProjection | null = null;
  private inflightToken: Promise<TeamRuntimeWebhookAuthProjection> | null = null;

  constructor(private readonly deps: TeamRuntimeWebhookAuthServiceDeps) {}

  async getPublicAuthProjection(): Promise<TeamRuntimeWebhookPublicAuthProjection> {
    return this.createPublicProjection(await this.readOrCreateAuthProjection());
  }

  async getToken(): Promise<string> {
    return (await this.readOrCreateAuthProjection()).token;
  }

  private async readOrCreateAuthProjection(): Promise<TeamRuntimeWebhookAuthProjection> {
    const environmentToken = this.readEnvironmentToken();
    if (environmentToken) {
      return this.createProjection(environmentToken, 'environment');
    }

    if (this.cachedToken) {
      return this.cachedToken;
    }
    if (this.inflightToken) {
      return await this.inflightToken;
    }

    this.inflightToken = this.readOrCreateSettingsToken();
    try {
      this.cachedToken = await this.inflightToken;
      return this.cachedToken;
    } finally {
      this.inflightToken = null;
    }
  }

  private readEnvironmentToken(): string {
    return this.deps.environment.getEnv(TEAM_WEBHOOK_TOKEN_ENV).trim();
  }

  private async readOrCreateSettingsToken(): Promise<TeamRuntimeWebhookAuthProjection> {
    const settings = await this.deps.settingsRepository.getAll();
    const existingToken = readSettingsToken(settings);
    if (existingToken) {
      return this.createProjection(existingToken, 'settings');
    }

    const generatedToken = this.createToken();
    await this.deps.settingsRepository.setValue(TEAM_WEBHOOK_TOKEN_SETTING_KEY, generatedToken);
    return this.createProjection(generatedToken, 'settings');
  }

  private createToken(): string {
    return `mctwh_${this.deps.idGenerator.randomHex(32)}`;
  }

  private createProjection(token: string, source: TeamRuntimeWebhookTokenSource): TeamRuntimeWebhookAuthProjection {
    return {
      success: true,
      token,
      source,
      headerName: 'x-matchaclaw-webhook-token',
      authorizationScheme: 'Bearer',
    };
  }

  private createPublicProjection(projection: TeamRuntimeWebhookAuthProjection): TeamRuntimeWebhookPublicAuthProjection {
    return {
      success: true,
      enabled: true,
      source: projection.source,
      headerName: projection.headerName,
      authorizationScheme: projection.authorizationScheme,
      maskedToken: maskWebhookToken(projection.token),
      copySupported: false,
    };
  }
}

function maskWebhookToken(token: string): string {
  const trimmedToken = token.trim();
  if (trimmedToken.length <= 8) {
    return '••••';
  }
  return `${trimmedToken.slice(0, 6)}…${trimmedToken.slice(-4)}`;
}

function readSettingsToken(settings: Record<string, unknown>): string {
  const value = settings[TEAM_WEBHOOK_TOKEN_SETTING_KEY];
  return typeof value === 'string' ? value.trim() : '';
}
