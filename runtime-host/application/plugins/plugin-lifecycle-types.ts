export interface RuntimePluginTransitionLifecycleState {
  readonly previousEnabledPluginIds: readonly string[];
  readonly nextEnabledPluginIds: readonly string[];
  readonly newlyEnabledPluginIds: readonly string[];
  readonly newlyDisabledPluginIds: readonly string[];
}

export interface RuntimePluginConfigLifecycleContext extends RuntimePluginTransitionLifecycleState {
  readonly pluginId: string;
}

export interface RuntimePluginSideEffectLifecycleContext extends RuntimePluginTransitionLifecycleState {
  readonly pluginId: string;
}

export interface RuntimePluginStartupConfigLifecycleContext {
  readonly pluginId: string;
  readonly enabledPluginIds: readonly string[];
}

export interface RuntimePluginStartupSideEffectLifecycleContext {
  readonly pluginId: string;
  readonly enabledPluginIds: readonly string[];
}

export interface RuntimePluginLifecycle {
  readonly id: string;
  readonly onEnableConfig?: (
    config: Record<string, unknown>,
    context: RuntimePluginConfigLifecycleContext,
  ) => Promise<Record<string, unknown>> | Record<string, unknown>;
  readonly onDisableConfig?: (
    config: Record<string, unknown>,
    context: RuntimePluginConfigLifecycleContext,
  ) => Promise<Record<string, unknown>> | Record<string, unknown>;
  readonly onEnable?: (
    context: RuntimePluginSideEffectLifecycleContext,
  ) => Promise<void> | void;
  readonly onDisable?: (
    context: RuntimePluginSideEffectLifecycleContext,
  ) => Promise<void> | void;
  readonly onStartupConfig?: (
    config: Record<string, unknown>,
    context: RuntimePluginStartupConfigLifecycleContext,
  ) => Promise<Record<string, unknown>> | Record<string, unknown>;
  readonly onStartup?: (
    context: RuntimePluginStartupSideEffectLifecycleContext,
  ) => Promise<void> | void;
}
