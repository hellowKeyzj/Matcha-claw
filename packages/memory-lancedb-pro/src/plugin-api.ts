import type { OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";

type MemoryRuntimeRegistration = {
  getMemorySearchManager?(params: unknown): Promise<unknown>;
  resolveMemoryBackendConfig?(): unknown;
};

export type MemoryPluginApi = Omit<OpenClawPluginApi, "on" | "registerHook" | "registerTool"> & {
  on(...args: any[]): void;
  registerHook?(...args: any[]): void;
  registerTool(...args: any[]): void;
  registerMemoryRuntime?(runtime: MemoryRuntimeRegistration): void;
};
