export type AppPluginKind = 'reader' | 'connector';

export interface AppReaderManifest {
  readonly id: string;
  readonly name: string;
  readonly entry: string;
  readonly extensions: readonly string[];
  readonly mimeTypes?: readonly string[];
  readonly contentType: 'text' | 'code' | 'markdown' | 'html' | 'image' | 'document' | 'binary';
  readonly source: 'text' | 'binary';
  readonly priority?: number;
}

export type ConnectorFieldName = 'url' | 'transport' | 'connectionTimeoutMs' | 'headers' | 'secretHeaders';

export interface ConnectorFieldHint {
  readonly label?: string;
  readonly description?: string;
  readonly placeholder?: string;
}

export interface AppConnectorManifest {
  readonly id: string;
  readonly displayName: string;
  readonly description?: string;
  readonly kind: 'mcp-http';
  readonly defaultUrl?: string;
  readonly defaultTransport?: 'streamable-http' | 'sse';
  readonly fieldHints?: Partial<Record<ConnectorFieldName, ConnectorFieldHint>>;
}

export interface AppPluginManifest {
  readonly schemaVersion: 1;
  readonly id: string;
  readonly name: string;
  readonly version: string;
  readonly description?: string;
  readonly contributes: {
    readonly readers?: readonly AppReaderManifest[];
    readonly connectors?: readonly AppConnectorManifest[];
  };
}

export interface InstalledAppPlugin {
  readonly manifest: AppPluginManifest;
  readonly digest: string;
  readonly enabled: boolean;
  readonly origin: 'manual' | 'agent';
  readonly installedAt: string;
  readonly previous?: {
    readonly manifest: AppPluginManifest;
    readonly digest: string;
    readonly origin: 'manual' | 'agent';
    readonly installedAt: string;
  };
}

export interface AppPluginCatalog {
  readonly revision: number;
  readonly plugins: readonly InstalledAppPlugin[];
}

export interface AppPluginInspection {
  readonly manifest: AppPluginManifest;
  readonly digest: string;
}

export interface AppPluginBuild extends AppPluginInspection {
  readonly packageBase64: string;
}

export interface AppPluginDevelopment {
  readonly requestId: string;
  readonly kind: AppPluginKind;
  readonly pluginId?: string;
  readonly expiresAt: string;
}

export function appConnectorSourceId(packageId: string, connectorId: string): string {
  return `app-plugin:${packageId}:connector:${connectorId}`;
}

export function appPluginHasKind(manifest: AppPluginManifest, kind: AppPluginKind): boolean {
  return kind === 'reader' ? !!manifest.contributes.readers?.length : !!manifest.contributes.connectors?.length;
}
