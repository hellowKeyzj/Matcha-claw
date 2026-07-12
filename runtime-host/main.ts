import { createRuntimeHostProcess } from './composition/runtime-host-composition';

const runtimeHostProcess = createRuntimeHostProcess();

process.on('message', (message: unknown) => {
  if (
    message
    && typeof message === 'object'
    && 'type' in message
    && message.type === 'matchaclaw:shutdown'
  ) {
    void runtimeHostProcess.shutdown(0);
  }
});

void runtimeHostProcess.start().catch((error) => {
  console.error('[runtime-host] failed to start', error);
  process.exit(1);
});
