export interface WorkbenchRuntimeState {
  lifecycle: string;
  plugins: Array<{ lifecycle?: string }>;
}

export function buildWorkbenchBootstrapPayload(state: WorkbenchRuntimeState, generatedAt: number) {
  return {
    success: true,
    generatedAt,
    runtime: {
      lifecycle: state.lifecycle,
      activePluginCount: state.plugins.filter((plugin) => plugin.lifecycle === 'active').length,
    },
    plugins: state.plugins,
  };
}
