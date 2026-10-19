import type { NativeRuntimeEndpointRef } from './desktop/runtime-address';

export interface SearchEngineConfig {
  name: string;
  enabled: boolean;
  timeoutSeconds: number | null;
  weight: number | null;
}

export interface SearchRuntimeConfig {
  endpoint: NativeRuntimeEndpointRef;
  enabled: boolean;
}

export interface SearchConfig {
  enabled: boolean;
  autoStart: boolean;
  categories: string[];
  language: string;
  safeSearch: 0 | 1 | 2;
  resultCount: number;
  requestTimeoutSeconds: number;
  proxyUrl: string | null;
  engines: SearchEngineConfig[];
  runtimes: SearchRuntimeConfig[];
}

export interface SearchEngine {
  name: string;
  categories: string[];
  enabled: boolean;
  languageSupport: boolean;
  safeSearch: boolean;
  timeoutSeconds: number;
}

export type SearchRuntimePhase = 'disabled' | 'notConfigured' | 'pendingRestart' | 'ready' | 'failed';

export interface SearchRuntimeState {
  endpoint: NativeRuntimeEndpointRef;
  enabled: boolean;
  phase: SearchRuntimePhase;
  error: string | null;
}

export interface SearchSnapshot {
  revision: number;
  appliedRevision: number | null;
  config: SearchConfig;
  service: {
    phase: 'stopped' | 'preparing' | 'starting' | 'running' | 'failed';
    error: string | null;
  };
  engines: SearchEngine[];
  runtimes: SearchRuntimeState[];
}

export interface SearchHit {
  title: string;
  url: string;
  snippet: string;
}

export interface SearchVerifyRequest {
  query: string;
  engines?: string[];
  categories?: string[];
  endpoint?: NativeRuntimeEndpointRef;
}

export interface SearchVerification {
  results: SearchHit[];
  unresponsiveEngines: unknown;
  elapsedMs: number;
}
