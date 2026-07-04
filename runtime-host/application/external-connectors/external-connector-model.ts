export type ExternalConnectorKind = 'mcp-stdio' | 'mcp-http' | 'cli' | 'sdk' | 'http';

export type ExternalMcpServerProgramSource = 'system-runtime' | 'external-command' | 'external-url' | 'bundled-plugin' | 'bundled-mcp-app' | 'managed-local';

export interface ExternalMcpServerProgramRef {
  readonly source: ExternalMcpServerProgramSource;
  readonly programId?: string;
}

export interface ExternalConnectorSecretRef {
  readonly kind: 'secret-ref';
  readonly ref: string;
}

export interface ExternalConnectorBaseSpec {
  readonly id: string;
  readonly kind: ExternalConnectorKind;
  readonly displayName?: string;
  readonly description?: string;
  readonly enabled?: boolean;
  readonly workspaceId?: string;
  readonly sourceId?: string;
  readonly mcpServerProgram?: ExternalMcpServerProgramRef;
  readonly tags?: readonly string[];
}

export interface ExternalConnectorProcessSpec extends ExternalConnectorBaseSpec {
  readonly kind: 'mcp-stdio' | 'cli';
  readonly command: string;
  readonly args?: readonly string[];
  readonly cwd?: string;
  readonly env?: Record<string, string>;
  readonly secretEnv?: Record<string, ExternalConnectorSecretRef>;
}

export interface ExternalConnectorMcpHttpSpec extends ExternalConnectorBaseSpec {
  readonly kind: 'mcp-http';
  readonly url: string;
  readonly transport?: 'streamable-http' | 'sse';
  readonly headers?: Record<string, string>;
  readonly secretHeaders?: Record<string, ExternalConnectorSecretRef>;
  readonly connectionTimeoutMs?: number;
}

export interface ExternalConnectorHttpSpec extends ExternalConnectorBaseSpec {
  readonly kind: 'http';
  readonly baseUrl: string;
  readonly headers?: Record<string, string>;
  readonly secretHeaders?: Record<string, ExternalConnectorSecretRef>;
}

export interface ExternalConnectorSdkSpec extends ExternalConnectorBaseSpec {
  readonly kind: 'sdk';
  readonly provider: string;
  readonly packageName?: string;
  readonly config?: Record<string, unknown>;
  readonly secretConfigRefs?: Record<string, ExternalConnectorSecretRef>;
}

export type ExternalConnectorSpec =
  | ExternalConnectorProcessSpec
  | ExternalConnectorMcpHttpSpec
  | ExternalConnectorHttpSpec
  | ExternalConnectorSdkSpec;

export type ExternalConnectorValidationResult =
  | { readonly resultType: 'valid'; readonly connector: ExternalConnectorSpec }
  | { readonly resultType: 'invalid'; readonly reason: string };

const CONNECTOR_ID_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$/;

const BLOCKED_PROCESS_ENV_KEYS = new Set([
  'NODE_OPTIONS',
  'PYTHONSTARTUP',
  'PYTHONPATH',
  'PERL5OPT',
  'RUBYOPT',
  'SHELLOPTS',
  'PS4',
]);

const SECRET_KEY_PATTERN = /(authorization|cookie|token|secret|password|passwd|api[-_]?key|private[-_]?key|credential)/i;
const MCP_SERVER_PROGRAM_SOURCES = new Set<ExternalMcpServerProgramSource>([
  'system-runtime',
  'external-command',
  'external-url',
  'bundled-plugin',
  'bundled-mcp-app',
  'managed-local',
]);

export function validateExternalConnectorSpec(input: unknown): ExternalConnectorValidationResult {
  if (!isRecord(input)) {
    return invalid('External connector spec must be an object');
  }

  const baseError = validateBaseSpec(input);
  if (baseError) {
    return invalid(baseError);
  }

  switch (input.kind) {
    case 'mcp-stdio':
    case 'cli':
      return validateProcessConnector(input as Record<string, unknown> & { kind: 'mcp-stdio' | 'cli' });
    case 'mcp-http':
      return validateMcpHttpConnector(input as Record<string, unknown> & { kind: 'mcp-http' });
    case 'http':
      return validateHttpConnector(input as Record<string, unknown> & { kind: 'http' });
    case 'sdk':
      return validateSdkConnector(input as Record<string, unknown> & { kind: 'sdk' });
    default:
      return invalid('External connector kind must be mcp-stdio, mcp-http, cli, sdk, or http');
  }
}

export function assertExternalConnectorSpec(input: unknown): ExternalConnectorSpec {
  const result = validateExternalConnectorSpec(input);
  if (result.resultType === 'invalid') {
    throw new Error(result.reason);
  }
  return result.connector;
}

function validateBaseSpec(input: Record<string, unknown>): string | null {
  if (!isNonEmptyString(input.id)) {
    return 'External connector id is required';
  }
  if (!CONNECTOR_ID_PATTERN.test(input.id)) {
    return 'External connector id must start with a letter or number and only contain letters, numbers, dot, underscore, or dash';
  }
  if (!isNonEmptyString(input.kind)) {
    return 'External connector kind is required';
  }
  if (input.mcpServerProgram !== undefined && input.kind !== 'mcp-stdio' && input.kind !== 'mcp-http') {
    return 'mcpServerProgram is only supported by mcp-stdio and mcp-http connectors';
  }
  return validateOptionalStrings(input, ['displayName', 'description', 'workspaceId', 'sourceId'])
    ?? validateOptionalBoolean(input, 'enabled')
    ?? validateOptionalMcpServerProgram(input.mcpServerProgram)
    ?? validateOptionalStringArray(input, 'tags');
}

function validateProcessConnector(input: Record<string, unknown> & { kind: 'mcp-stdio' | 'cli' }): ExternalConnectorValidationResult {
  const error = validateRequiredStrings(input, ['command'])
    ?? validateOptionalStringArray(input, 'args')
    ?? validateOptionalStrings(input, ['cwd'])
    ?? validatePlainStringMap(input.env, 'env')
    ?? validateSecretRefMap(input.secretEnv, 'secretEnv')
    ?? validatePublicMapHasNoSecretKeys(input.env, 'env')
    ?? validateProcessEnvKeys(input.env, input.kind)
    ?? validateProcessEnvKeys(secretRefMapKeys(input.secretEnv), input.kind);
  return error ? invalid(error) : valid(cloneConnector(input as unknown as ExternalConnectorSpec));
}

function validateMcpHttpConnector(input: Record<string, unknown> & { kind: 'mcp-http' }): ExternalConnectorValidationResult {
  const error = validateRequiredUrl(input.url, 'url')
    ?? validateMcpHttpTransport(input.transport)
    ?? validatePlainStringMap(input.headers, 'headers')
    ?? validateSecretRefMap(input.secretHeaders, 'secretHeaders')
    ?? validatePublicMapHasNoSecretKeys(input.headers, 'headers')
    ?? validateOptionalPositiveInteger(input.connectionTimeoutMs, 'connectionTimeoutMs');
  return error ? invalid(error) : valid(cloneConnector(input as unknown as ExternalConnectorSpec));
}

function validateHttpConnector(input: Record<string, unknown> & { kind: 'http' }): ExternalConnectorValidationResult {
  const error = validateRequiredUrl(input.baseUrl, 'baseUrl')
    ?? validatePlainStringMap(input.headers, 'headers')
    ?? validateSecretRefMap(input.secretHeaders, 'secretHeaders')
    ?? validatePublicMapHasNoSecretKeys(input.headers, 'headers');
  return error ? invalid(error) : valid(cloneConnector(input as unknown as ExternalConnectorSpec));
}

function validateSdkConnector(input: Record<string, unknown> & { kind: 'sdk' }): ExternalConnectorValidationResult {
  const config = input.config;
  const error = validateRequiredStrings(input, ['provider'])
    ?? validateOptionalStrings(input, ['packageName'])
    ?? (config === undefined || isRecord(config) ? null : 'config must be an object')
    ?? validateSecretRefMap(input.secretConfigRefs, 'secretConfigRefs')
    ?? validateConfigHasNoInlineSecrets(config);
  return error ? invalid(error) : valid(cloneConnector(input as unknown as ExternalConnectorSpec));
}

function validateRequiredStrings(input: Record<string, unknown>, keys: readonly string[]): string | null {
  for (const key of keys) {
    if (!isNonEmptyString(input[key])) {
      return `${key} is required`;
    }
  }
  return null;
}

function validateOptionalStrings(input: Record<string, unknown>, keys: readonly string[]): string | null {
  for (const key of keys) {
    if (input[key] !== undefined && typeof input[key] !== 'string') {
      return `${key} must be a string`;
    }
  }
  return null;
}

function validateOptionalBoolean(input: Record<string, unknown>, key: string): string | null {
  return input[key] !== undefined && typeof input[key] !== 'boolean'
    ? `${key} must be a boolean`
    : null;
}

function validateOptionalStringArray(input: Record<string, unknown>, key: string): string | null {
  const value = input[key];
  if (value === undefined) {
    return null;
  }
  return Array.isArray(value) && value.every((item) => typeof item === 'string')
    ? null
    : `${key} must be an array of strings`;
}

function validateOptionalMcpServerProgram(value: unknown): string | null {
  if (value === undefined) {
    return null;
  }
  if (!isRecord(value)) {
    return 'mcpServerProgram must be an object';
  }
  if (!MCP_SERVER_PROGRAM_SOURCES.has(value.source as ExternalMcpServerProgramSource)) {
    return 'mcpServerProgram.source must be system-runtime, external-command, external-url, bundled-plugin, bundled-mcp-app, or managed-local';
  }
  return validateOptionalStrings(value, ['programId']);
}

function validatePlainStringMap(value: unknown, key: string): string | null {
  if (value === undefined) {
    return null;
  }
  if (!isRecord(value)) {
    return `${key} must be an object`;
  }
  for (const [entryKey, entryValue] of Object.entries(value)) {
    if (!entryKey.trim()) {
      return `${key} key is required`;
    }
    if (typeof entryValue !== 'string') {
      return `${key}.${entryKey} must be a string`;
    }
  }
  return null;
}

function validateSecretRefMap(value: unknown, key: string): string | null {
  if (value === undefined) {
    return null;
  }
  if (!isRecord(value)) {
    return `${key} must be an object`;
  }
  for (const [entryKey, entryValue] of Object.entries(value)) {
    if (!entryKey.trim()) {
      return `${key} key is required`;
    }
    if (!isRecord(entryValue) || entryValue.kind !== 'secret-ref' || !isNonEmptyString(entryValue.ref)) {
      return `${key}.${entryKey} must be a secret-ref`;
    }
  }
  return null;
}

function validatePublicMapHasNoSecretKeys(value: unknown, key: string): string | null {
  if (!isRecord(value)) {
    return null;
  }
  const secretKey = Object.keys(value).find((entryKey) => SECRET_KEY_PATTERN.test(entryKey));
  return secretKey
    ? `${key}.${secretKey} looks secret-bearing; use the matching secret* field instead`
    : null;
}

function validateConfigHasNoInlineSecrets(value: unknown): string | null {
  if (!isRecord(value)) {
    return null;
  }
  const secretPath = findSecretLikeConfigPath(value);
  return secretPath ? `config.${secretPath} looks secret-bearing; use secretConfigRefs instead` : null;
}

function findSecretLikeConfigPath(value: Record<string, unknown>, prefix = ''): string | null {
  for (const [key, item] of Object.entries(value)) {
    const path = prefix ? `${prefix}.${key}` : key;
    if (SECRET_KEY_PATTERN.test(key)) {
      return path;
    }
    if (isRecord(item)) {
      const nested = findSecretLikeConfigPath(item, path);
      if (nested) {
        return nested;
      }
    }
  }
  return null;
}

function validateProcessEnvKeys(value: unknown, connectorKind: ExternalConnectorKind): string | null {
  if (!isRecord(value)) {
    return null;
  }
  const blockedKey = Object.keys(value).find((key) => BLOCKED_PROCESS_ENV_KEYS.has(key));
  return blockedKey
    ? `${connectorKind} env.${blockedKey} is blocked because it can change process startup behavior`
    : null;
}

function validateRequiredUrl(value: unknown, key: string): string | null {
  if (!isNonEmptyString(value)) {
    return `${key} is required`;
  }
  try {
    const url = new URL(value);
    return url.protocol === 'http:' || url.protocol === 'https:'
      ? null
      : `${key} must use http or https`;
  } catch {
    return `${key} must be a valid URL`;
  }
}

function validateMcpHttpTransport(value: unknown): string | null {
  if (value === undefined) {
    return null;
  }
  return value === 'streamable-http' || value === 'sse'
    ? null
    : 'transport must be streamable-http or sse';
}

function validateOptionalPositiveInteger(value: unknown, key: string): string | null {
  if (value === undefined) {
    return null;
  }
  return typeof value === 'number' && Number.isInteger(value) && value > 0
    ? null
    : `${key} must be a positive integer`;
}

function secretRefMapKeys(value: unknown): Record<string, string> | null {
  if (!isRecord(value)) {
    return null;
  }
  return Object.fromEntries(Object.keys(value).map((key) => [key, '']));
}

function valid(connector: ExternalConnectorSpec): ExternalConnectorValidationResult {
  return { resultType: 'valid', connector };
}

function invalid(reason: string): ExternalConnectorValidationResult {
  return { resultType: 'invalid', reason };
}

function cloneConnector(connector: ExternalConnectorSpec): ExternalConnectorSpec {
  return structuredClone(connector);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}
