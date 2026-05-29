import { describe, expect, it } from 'vitest';
import { SessionRuntimeStateStore } from '../../runtime-host/application/sessions/session-runtime-state';

function createStore() {
  const saves: Array<{ version: 3; activeSessionKey: string | null }> = [];
  const store = new SessionRuntimeStateStore({
    runtimeStore: {
      load: async () => ({ version: 3, activeSessionKey: null }),
      save: async (payload) => {
        saves.push(payload);
      },
    },
  });
  return { store, saves };
}

describe('SessionRuntimeStateStore', () => {
  it('coalesces repeated async persist requests into one runtime store write', async () => {
    const { store, saves } = createStore();

    await store.ready();
    store.setActiveSessionKey('agent:main:one');
    store.persistStore();
    store.persistStore();
    store.persistStore();

    await store.flushPersistedStore();

    expect(saves).toEqual([{ version: 3, activeSessionKey: 'agent:main:one' }]);
  });
});
