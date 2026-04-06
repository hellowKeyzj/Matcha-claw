import type { RuntimeHostState } from '../../shared/types';

export function buildWorkbenchBootstrapPayload(state: RuntimeHostState) {
  return {
    success: true,
    generatedAt: Date.now(),
    runtime: {
      lifecycle: state.lifecycle,
      activePluginCount: state.plugins.filter((plugin) => plugin.lifecycle === 'active').length,
    },
    plugins: state.plugins,
  };
}
