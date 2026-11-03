export type AppPluginKind = 'reader' | 'connector' | 'application';

export interface AppApplicationManifest {
  readonly id: string;
  readonly name: string;
  readonly entry: string;
  readonly placement?: 'page' | 'chat-panel' | 'both';
  readonly imageEditor?: {
    readonly label: string;
    readonly tool: string;
    readonly translations?: Readonly<Record<string, string>>;
  };
}

export interface AppToolManifest {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: Readonly<Record<string, unknown>>;
  readonly outputSchema?: Readonly<Record<string, unknown>>;
  readonly _meta?: Readonly<Record<string, unknown>>;
}

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

export type AppPluginBackend =
  | { readonly language: 'python'; readonly entry: string; readonly pythonVersion: '3.12' }
  | { readonly language: 'rust'; readonly entry: string; readonly platform: 'win32' | 'darwin' | 'linux'; readonly arch: 'x64' | 'arm64' };

export interface AppPluginManifest {
  readonly schemaVersion: 1;
  readonly id: string;
  readonly name: string;
  readonly version: string;
  readonly description?: string;
  readonly apiVersion?: 1;
  readonly main?: string;
  readonly backend?: AppPluginBackend;
  readonly contributes: {
    readonly readers?: readonly AppReaderManifest[];
    readonly connectors?: readonly AppConnectorManifest[];
    readonly applications?: readonly AppApplicationManifest[];
    readonly chat?: { readonly contextTag: string };
    readonly tools?: readonly AppToolManifest[];
  };
}

export interface InstalledAppPlugin {
  readonly manifest: AppPluginManifest;
  readonly digest: string;
  readonly enabled: boolean;
  readonly origin: 'manual' | 'agent' | 'bundled';
  readonly installedAt: string;
  readonly previous?: {
    readonly manifest: AppPluginManifest;
    readonly digest: string;
    readonly origin: 'manual' | 'agent' | 'bundled';
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
  readonly developmentId: string;
}

export interface AppPluginDevelopmentConnection extends AppPluginDevelopment {
  readonly baseUrl: string;
  readonly token: string;
}

export function appConnectorSourceId(packageId: string, connectorId: string): string {
  return `app-plugin:${packageId}:connector:${connectorId}`;
}

export function appPluginHasKind(manifest: AppPluginManifest, kind: AppPluginKind): boolean {
  switch (kind) {
    case 'reader': return !!manifest.contributes.readers?.length;
    case 'connector': return !!manifest.contributes.connectors?.length;
    case 'application': return !!manifest.main || !!manifest.backend || !!manifest.contributes.applications?.length;
  }
}
