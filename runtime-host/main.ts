import { createRuntimeHostProcess } from './composition/runtime-host-composition';

void createRuntimeHostProcess().start().catch((error) => {
  console.error('[runtime-host] failed to start', error);
  process.exit(1);
});
