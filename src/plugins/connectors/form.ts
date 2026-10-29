import type { ExternalConnectorKind, ExternalConnectorSecretRef, ExternalConnectorSpec, ExternalConnectorSummary, ExternalConnectorPatch, ExternalMcpServerProgramDescriptor } from './types';

export type PrivateField = 'command' | 'args' | 'cwd' | 'env' | 'headers' | 'config';

export type ConnectorFormState = {
  id: string;
  kind: ExternalConnectorKind;
  enabled: boolean;
  displayName: string;
  description: string;
  command: string;
  args: string;
  cwd: string;
  env: string;
  secretEnv: string;
  url: string;
  transport: 'streamable-http' | 'sse';
  auth: '' | 'oauth';
  baseUrl: string;
  headers: string;
  secretHeaders: string;
  connectionTimeoutMs: string;
  provider: string;
  packageName: string;
  config: string;
  secretConfigRefs: string;
  mcpServerProgramId: string;
  replaceFields: PrivateField[];
};

export const EMPTY_FORM: ConnectorFormState = {
  id: '',
  kind: 'mcp-stdio',
  enabled: true,
  displayName: '',
  description: '',
  command: '',
  args: '',
  cwd: '',
  env: '',
  secretEnv: '',
  url: '',
  transport: 'streamable-http',
  auth: '',
  baseUrl: '',
  headers: '',
  secretHeaders: '',
  connectionTimeoutMs: '',
  provider: '',
  packageName: '',
  config: '',
  secretConfigRefs: '',
  mcpServerProgramId: '',
  replaceFields: [],
};

function parseStringMap(value: string, fieldName: string): Record<string, string> | undefined {
  const entries = value.split('\n').map((line) => line.trim()).filter(Boolean);
  if (entries.length === 0) {
    return undefined;
  }
  const result: Record<string, string> = {};
  for (const entry of entries) {
    const separatorIndex = entry.indexOf('=');
    if (separatorIndex <= 0) {
      throw new Error(`${fieldName} 每行必须是 KEY=value`);
    }
    const key = entry.slice(0, separatorIndex).trim();
    const itemValue = entry.slice(separatorIndex + 1).trim();
    if (!key) {
      throw new Error(`${fieldName} key 不能为空`);
    }
    result[key] = itemValue;
  }
  return result;
}

function parseSecretRefMap(value: string, fieldName: string): Record<string, ExternalConnectorSecretRef> | undefined {
  const entries = parseStringMap(value, fieldName);
  if (!entries) {
    return undefined;
  }
  return Object.fromEntries(Object.entries(entries).map(([key, ref]) => [key, { kind: 'secret-ref', ref }]));
}

function parseJsonObject(value: string): Record<string, unknown> | undefined {
  const trimmed = value.trim();
  if (!trimmed) {
    return undefined;
  }
  const parsed = JSON.parse(trimmed) as unknown;
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('SDK config 必须是 JSON object');
  }
  return parsed as Record<string, unknown>;
}

function splitArgs(value: string): string[] | undefined {
  const args = value.split('\n').map((line) => line.trim()).filter(Boolean);
  return args.length > 0 ? args : undefined;
}

function serializeSecretRefMap(value?: Record<string, ExternalConnectorSecretRef>): string {
  return value ? Object.entries(value).map(([key, itemValue]) => `${key}=${itemValue.ref}`).join('\n') : '';
}

function formFromSummary(connector: ExternalConnectorSummary): ConnectorFormState {
  return {
    ...EMPTY_FORM,
    id: connector.id,
    kind: connector.kind,
    enabled: connector.enabled !== false,
    displayName: connector.displayName ?? '',
    description: connector.description ?? '',
    mcpServerProgramId: connector.mcpServerProgram?.programId ?? '',
  };
}

function connectorBase(form: ConnectorFormState) {
  return {
    id: form.id.trim(),
    kind: form.kind,
    enabled: form.enabled,
    displayName: form.displayName.trim() || undefined,
    description: form.description.trim() || undefined,
  };
}

function commonPatch(form: ConnectorFormState, connector: ExternalConnectorSummary): ExternalConnectorPatch {
  const original = formFromSummary(connector);
  return {
    ...(form.displayName !== original.displayName ? { displayName: form.displayName.trim() || null } : {}),
    ...(form.description !== original.description ? { description: form.description.trim() || null } : {}),
    ...(form.enabled !== original.enabled ? { enabled: form.enabled } : {}),
  };
}

function mcpServerProgram(form: ConnectorFormState, programs: readonly ExternalMcpServerProgramDescriptor[]) {
  const selectedProgram = programs.find((program) => program.id === form.mcpServerProgramId && program.connectorKinds.includes(form.kind as 'mcp-stdio' | 'mcp-http'));
  return selectedProgram ? { source: selectedProgram.source, programId: selectedProgram.id } : undefined;
}

export const processForm = {
  fromSummary(connector: ExternalConnectorSummary): ConnectorFormState {
    const process = connector as Extract<ExternalConnectorSummary, { kind: 'mcp-stdio' | 'cli' }>;
    return {
      ...formFromSummary(connector),
      secretEnv: serializeSecretRefMap(process.secretEnv),
    };
  },
  create(form: ConnectorFormState): ExternalConnectorSpec {
    return withoutUndefined({
      ...connectorBase(form),
      command: form.command.trim(),
      args: splitArgs(form.args),
      cwd: form.cwd.trim() || undefined,
      env: parseStringMap(form.env, 'env'),
      secretEnv: parseSecretRefMap(form.secretEnv, 'secretEnv'),
    }) as ExternalConnectorSpec;
  },
  patch(form: ConnectorFormState, connector: ExternalConnectorSummary): ExternalConnectorPatch {
    const original = processForm.fromSummary(connector);
    const replace = (field: PrivateField) => form.replaceFields.includes(field);
    return {
      ...commonPatch(form, connector),
      ...(replace('command') ? { command: form.command.trim() } : {}),
      ...(replace('args') ? { args: splitArgs(form.args) ?? null } : {}),
      ...(replace('cwd') ? { cwd: form.cwd.trim() || null } : {}),
      ...(replace('env') ? { env: parseStringMap(form.env, 'env') ?? null } : {}),
      ...(form.secretEnv !== original.secretEnv ? { secretEnv: parseSecretRefMap(form.secretEnv, 'secretEnv') ?? null } : {}),
    };
  },
};

export const mcpStdioForm = {
  ...processForm,
  create(form: ConnectorFormState, programs: readonly ExternalMcpServerProgramDescriptor[]): ExternalConnectorSpec {
    return withoutUndefined({
      ...processForm.create(form),
      mcpServerProgram: mcpServerProgram(form, programs),
    });
  },
};

export const mcpHttpForm = {
  fromSummary(connector: ExternalConnectorSummary): ConnectorFormState {
    const http = connector as Extract<ExternalConnectorSummary, { kind: 'mcp-http' }>;
    return {
      ...formFromSummary(connector),
      url: http.url,
      transport: http.transport ?? 'streamable-http',
      auth: http.auth ?? '',
      secretHeaders: serializeSecretRefMap(http.secretHeaders),
      connectionTimeoutMs: http.connectionTimeoutMs ? String(http.connectionTimeoutMs) : '',
    };
  },
  create(form: ConnectorFormState, programs: readonly ExternalMcpServerProgramDescriptor[]): ExternalConnectorSpec {
    const timeoutText = form.connectionTimeoutMs.trim();
    return withoutUndefined({
      ...connectorBase(form),
      mcpServerProgram: mcpServerProgram(form, programs),
      url: form.url.trim(),
      transport: form.transport,
      auth: form.auth || undefined,
      headers: parseStringMap(form.headers, 'headers'),
      secretHeaders: parseSecretRefMap(form.secretHeaders, 'secretHeaders'),
      connectionTimeoutMs: timeoutText ? Number(timeoutText) : undefined,
    }) as ExternalConnectorSpec;
  },
  patch(form: ConnectorFormState, connector: ExternalConnectorSummary): ExternalConnectorPatch {
    const original = mcpHttpForm.fromSummary(connector);
    return {
      ...commonPatch(form, connector),
      ...(form.url !== original.url ? { url: form.url.trim() } : {}),
      ...(form.transport !== original.transport ? { transport: form.transport } : {}),
      ...(form.auth !== original.auth ? { auth: form.auth || null } : {}),
      ...(form.connectionTimeoutMs !== original.connectionTimeoutMs ? { connectionTimeoutMs: form.connectionTimeoutMs.trim() ? Number(form.connectionTimeoutMs) : null } : {}),
      ...(form.replaceFields.includes('headers') ? { headers: parseStringMap(form.headers, 'headers') ?? null } : {}),
      ...(form.secretHeaders !== original.secretHeaders ? { secretHeaders: parseSecretRefMap(form.secretHeaders, 'secretHeaders') ?? null } : {}),
    };
  },
};

export const httpForm = {
  fromSummary(connector: ExternalConnectorSummary): ConnectorFormState {
    const http = connector as Extract<ExternalConnectorSummary, { kind: 'http' }>;
    return {
      ...formFromSummary(connector),
      baseUrl: http.baseUrl,
      secretHeaders: serializeSecretRefMap(http.secretHeaders),
    };
  },
  create(form: ConnectorFormState): ExternalConnectorSpec {
    return withoutUndefined({
      ...connectorBase(form),
      baseUrl: form.baseUrl.trim(),
      headers: parseStringMap(form.headers, 'headers'),
      secretHeaders: parseSecretRefMap(form.secretHeaders, 'secretHeaders'),
    }) as ExternalConnectorSpec;
  },
  patch(form: ConnectorFormState, connector: ExternalConnectorSummary): ExternalConnectorPatch {
    const original = httpForm.fromSummary(connector);
    return {
      ...commonPatch(form, connector),
      ...(form.baseUrl !== original.baseUrl ? { baseUrl: form.baseUrl.trim() } : {}),
      ...(form.replaceFields.includes('headers') ? { headers: parseStringMap(form.headers, 'headers') ?? null } : {}),
      ...(form.secretHeaders !== original.secretHeaders ? { secretHeaders: parseSecretRefMap(form.secretHeaders, 'secretHeaders') ?? null } : {}),
    };
  },
};

export const sdkForm = {
  fromSummary(connector: ExternalConnectorSummary): ConnectorFormState {
    const sdk = connector as Extract<ExternalConnectorSummary, { kind: 'sdk' }>;
    return {
      ...formFromSummary(connector),
      provider: sdk.provider,
      packageName: sdk.packageName ?? '',
      secretConfigRefs: serializeSecretRefMap(sdk.secretConfigRefs),
    };
  },
  create(form: ConnectorFormState): ExternalConnectorSpec {
    return withoutUndefined({
      ...connectorBase(form),
      provider: form.provider.trim(),
      packageName: form.packageName.trim() || undefined,
      config: parseJsonObject(form.config),
      secretConfigRefs: parseSecretRefMap(form.secretConfigRefs, 'secretConfigRefs'),
    }) as ExternalConnectorSpec;
  },
  patch(form: ConnectorFormState, connector: ExternalConnectorSummary): ExternalConnectorPatch {
    const original = sdkForm.fromSummary(connector);
    return {
      ...commonPatch(form, connector),
      ...(form.provider !== original.provider ? { provider: form.provider.trim() } : {}),
      ...(form.packageName !== original.packageName ? { packageName: form.packageName.trim() || null } : {}),
      ...(form.replaceFields.includes('config') ? { config: parseJsonObject(form.config) ?? null } : {}),
      ...(form.secretConfigRefs !== original.secretConfigRefs ? { secretConfigRefs: parseSecretRefMap(form.secretConfigRefs, 'secretConfigRefs') ?? null } : {}),
    };
  },
};

function withoutUndefined<T extends Record<string, unknown>>(input: T): T {
  return Object.fromEntries(Object.entries(input).filter(([, value]) => value !== undefined)) as T;
}
