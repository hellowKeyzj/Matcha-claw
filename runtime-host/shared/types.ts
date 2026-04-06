export type RuntimeHostLifecycle = 'idle' | 'booting' | 'running' | 'stopped' | 'error';

export type RuntimeHostPluginKind = 'builtin' | 'third-party';
export type RuntimeHostPluginPlatform = 'openclaw' | 'matchaclaw';
export type RuntimeHostPluginSource = 'workspace' | 'bundled' | 'openclaw-extension' | 'matchaclaw-extension';

export type RuntimeHostPluginLifecycle = 'inactive' | 'active' | 'failed';

export interface RuntimeHostPluginState {
  readonly id: string;
  readonly kind: RuntimeHostPluginKind;
  readonly platform?: RuntimeHostPluginPlatform;
  readonly lifecycle: RuntimeHostPluginLifecycle;
  readonly version?: string;
  readonly category?: string;
  readonly description?: string;
  readonly error?: string;
}

export interface RuntimeHostState {
  readonly lifecycle: RuntimeHostLifecycle;
  readonly plugins: readonly RuntimeHostPluginState[];
  readonly lastError?: string;
}

export interface RuntimeHostHealth {
  readonly ok: boolean;
  readonly lifecycle: RuntimeHostLifecycle;
  readonly activePluginCount: number;
  readonly degradedPlugins: readonly string[];
  readonly error?: string;
}

export interface RuntimeHostWorkbenchBootstrapPayload {
  readonly success: true;
  readonly generatedAt: number;
  readonly runtime: {
    readonly lifecycle: RuntimeHostLifecycle;
    readonly activePluginCount: number;
  };
  readonly plugins: readonly RuntimeHostPluginState[];
}

export interface RuntimeHostPluginManifest {
  readonly id: string;
  readonly name: string;
  readonly version: string;
  readonly category: string;
  readonly description?: string;
}

export interface RuntimeHostDiscoveredPlugin {
  readonly id: string;
  readonly kind: RuntimeHostPluginKind;
  readonly platform: RuntimeHostPluginPlatform;
  readonly source: RuntimeHostPluginSource;
  readonly rootDir: string;
  readonly manifestPath: string;
}

export interface RuntimeHostRequest {
  readonly method: 'GET' | 'POST' | 'PUT' | 'DELETE';
  readonly route: string;
  readonly payload?: unknown;
}

export interface RuntimeHostRouteResult<TData = unknown> {
  readonly status: number;
  readonly data: TData;
}
