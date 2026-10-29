export type ExternalConnectorKind = 'mcp-stdio' | 'mcp-http' | 'cli' | 'sdk' | 'http';

export type OpenClawMcpServerKind = 'mcp-stdio' | 'mcp-http' | 'unknown';
export type OpenClawMcpServerSource = 'preset' | 'external' | 'openclaw';

export interface OpenClawMcpServerSummary {
  readonly serverId: string;
  readonly connectorId?: string;
  readonly displayName: string;
  readonly description?: string;
  readonly kind: OpenClawMcpServerKind;
  readonly source: OpenClawMcpServerSource;
  readonly enabled: boolean;
  readonly managed: boolean;
  readonly editable: boolean;
  readonly removable: boolean;
}

export type ExternalMcpServerProgramSource = 'system-runtime' | 'external-command' | 'external-url' | 'bundled-plugin' | 'bundled-mcp-app' | 'managed-local';

export interface ExternalMcpServerProgramRef {
  readonly source: ExternalMcpServerProgramSource;
  readonly programId?: string;
}

export interface ExternalMcpServerProgramDescriptor {
  readonly id: string;
  readonly source: ExternalMcpServerProgramSource;
  readonly displayName: string;
  readonly connectorKinds: readonly Extract<ExternalConnectorKind, 'mcp-stdio' | 'mcp-http'>[];
  readonly transport?: 'streamable-http' | 'sse';
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
  readonly auth?: 'oauth';
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

export type ExternalConnectorSummary =
  | Omit<ExternalConnectorProcessSpec, 'command' | 'args' | 'cwd' | 'env'>
  | Omit<ExternalConnectorMcpHttpSpec, 'headers'>
  | Omit<ExternalConnectorHttpSpec, 'headers'>
  | Omit<ExternalConnectorSdkSpec, 'config'>;

export interface ExternalConnectorPatch {
  readonly displayName?: string | null;
  readonly description?: string | null;
  readonly enabled?: boolean;
  readonly command?: string;
  readonly args?: readonly string[] | null;
  readonly cwd?: string | null;
  readonly env?: Record<string, string> | null;
  readonly secretEnv?: Record<string, ExternalConnectorSecretRef> | null;
  readonly url?: string;
  readonly transport?: 'streamable-http' | 'sse' | null;
  readonly auth?: 'oauth' | null;
  readonly headers?: Record<string, string> | null;
  readonly secretHeaders?: Record<string, ExternalConnectorSecretRef> | null;
  readonly connectionTimeoutMs?: number | null;
  readonly baseUrl?: string;
  readonly provider?: string;
  readonly packageName?: string | null;
  readonly config?: Record<string, unknown> | null;
  readonly secretConfigRefs?: Record<string, ExternalConnectorSecretRef> | null;
}

export type ExternalConnectorMutationDesiredStatus = 'stored' | 'removed';

export interface ExternalConnectorMutationDesired {
  readonly status: ExternalConnectorMutationDesiredStatus;
  readonly revision?: number;
}

export type ExternalConnectorMutationApplied =
  | {
      readonly status: 'written';
      readonly changed: boolean;
    }
  | {
      readonly status: 'unknown' | 'unavailable';
      readonly changed?: never;
    };

export interface ExternalConnectorMutationObserved {
  readonly status: 'not-observed';
}

export interface ExternalConnectorUpsertMutationReceipt {
  readonly success: true;
  readonly connector: ExternalConnectorSummary;
  readonly resultType: 'created' | 'updated';
  readonly desired: ExternalConnectorMutationDesired & { readonly status: 'stored' };
  readonly applied: ExternalConnectorMutationApplied;
  readonly observed: ExternalConnectorMutationObserved;
}

export interface ExternalConnectorRemoveMutationReceipt {
  readonly success: true;
  readonly connector?: never;
  readonly desired: ExternalConnectorMutationDesired & { readonly status: 'removed' };
  readonly applied: ExternalConnectorMutationApplied;
  readonly observed: ExternalConnectorMutationObserved;
}

export type ExternalConnectorMutationReceipt =
  | ExternalConnectorUpsertMutationReceipt
  | ExternalConnectorRemoveMutationReceipt;

export type ExternalConnectorMutationPayload = ExternalConnectorUpsertMutationReceipt;

