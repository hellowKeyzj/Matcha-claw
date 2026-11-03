const MAX_ID_BYTES = 128;
export const MAX_SECRET_BYTES = 16 * 1024;
export const MAX_AUTH_PROFILES_BYTES = 1024 * 1024;
const MAX_PROVIDER_KEY_BYTES = 256;

export type OAuthProvider = 'openai' | 'openrouter' | 'github-copilot' | 'minimax-portal' | 'minimax-portal-cn' | 'qwen-portal';
export type AuthMode = 'apiKey' | 'oauthBrowser' | 'oauthDevice' | 'local' | 'token' | 'cliReuse';
export type CredentialAuthMode = Exclude<AuthMode, 'local' | 'cliReuse'>;
type AccountKind = 'chat' | 'media';
type ApiProtocol = 'anthropicMessages' | 'googleGenerativeAi' | 'openAiCompletions' | 'openAiResponses';
type MediaProtocol = 'google' | 'openAi' | 'openRouter' | 'dashScope' | 'ark';
export type ProviderAccountIntent = Readonly<{
  id: string;
  provider: string;
  label: string;
  enabled: boolean;
  kind: AccountKind;
  endpoint?: string;
  protocol?: ApiProtocol;
  mediaProtocol?: MediaProtocol;
  authMode: AuthMode;
  revision: number;
}>;
type AccountIntent = ProviderAccountIntent;

export function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

export function parseAccount(value: unknown): AccountIntent | null {
  const account = value as Partial<AccountIntent>;
  const kind = account?.kind ?? 'chat';
  if (!isId(account?.id)
    || !isProviderName(account.provider)
    || !isText(account.label)
    || typeof account.enabled !== 'boolean'
    || !isAccountKind(kind)
    || !optionalAccountText(account.endpoint, 2048)
    || !isAccountProtocols(kind, account.protocol, account.mediaProtocol)
    || !isAuthMode(account.authMode)
    || account.authMode === 'cliReuse' && (account.provider !== 'anthropic' || kind !== 'chat')
    || account.authMode === 'token' && (kind !== 'chat' || !['anthropic', 'github-copilot'].includes(account.provider))
    || !isRevision(account.revision)) {
    return null;
  }
  return {
    id: account.id,
    provider: account.provider,
    label: account.label,
    enabled: account.enabled,
    kind,
    ...(account.endpoint === undefined ? {} : { endpoint: account.endpoint }),
    ...(account.protocol === undefined ? {} : { protocol: account.protocol }),
    ...(account.mediaProtocol === undefined ? {} : { mediaProtocol: account.mediaProtocol }),
    authMode: account.authMode,
    revision: account.revision,
  };
}

function isAccountKind(value: unknown): value is AccountKind {
  return value === 'chat' || value === 'media';
}

function isAccountProtocols(
  kind: AccountKind,
  protocol: unknown,
  mediaProtocol: unknown,
): protocol is ApiProtocol | undefined {
  if (kind === 'media') return protocol === undefined && isMediaProtocol(mediaProtocol);
  return mediaProtocol === undefined && (protocol === undefined || isApiProtocol(protocol));
}

function isApiProtocol(value: unknown): value is ApiProtocol {
  return value === 'anthropicMessages'
    || value === 'googleGenerativeAi'
    || value === 'openAiCompletions'
    || value === 'openAiResponses';
}

function isMediaProtocol(value: unknown): value is MediaProtocol {
  return value === 'google' || value === 'openAi' || value === 'openRouter' || value === 'dashScope' || value === 'ark';
}

function optionalAccountText(value: unknown, maxLength: number): value is string | undefined {
  return value === undefined || (typeof value === 'string'
    && value.trim().length > 0
    && value.length <= maxLength
    && !/[\0\r\n]/.test(value));
}

export function isProvider(value: unknown): value is OAuthProvider {
  return value === 'openai' || value === 'openrouter' || value === 'github-copilot'
    || value === 'minimax-portal' || value === 'minimax-portal-cn' || value === 'qwen-portal';
}

export function isProfileProviderName(value: unknown): value is string {
  return typeof value === 'string' && value.length <= MAX_PROVIDER_KEY_BYTES && /^[A-Za-z0-9_.-]+$/.test(value);
}

export function isProviderName(value: unknown): value is string {
  return typeof value === 'string' && /^[A-Za-z0-9_.-]{1,128}$/.test(value);
}

export function isAuthMode(value: unknown): value is AuthMode {
  return value === 'apiKey' || value === 'oauthBrowser' || value === 'oauthDevice'
    || value === 'local' || value === 'token' || value === 'cliReuse';
}

export function isRevision(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
}

export function isId(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= MAX_ID_BYTES && /^[A-Za-z0-9_.:-]+$/.test(value);
}

export function isText(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0 && value.length <= 256 && !/[\0\r\n]/.test(value);
}

export function isSecret(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0 && Buffer.byteLength(value) <= MAX_SECRET_BYTES && !value.includes('\0');
}

export function isCredentialReference(value: unknown): value is string {
  return typeof value === 'string' && /^credential:v1:[A-Za-z0-9_.:-]{1,128}$/.test(value);
}

export function isTransactionId(value: unknown): value is string {
  return typeof value === 'string' && /^[a-f0-9]{8}(-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(value);
}
