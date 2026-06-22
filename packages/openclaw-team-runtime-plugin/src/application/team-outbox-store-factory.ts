import { randomUUID } from 'node:crypto'
import os from 'node:os'
import path from 'node:path'
import type { OpenClawPluginApi } from 'openclaw/plugin-sdk/plugin-entry'
import { SqliteTeamOutboxStore } from '../infrastructure/sqlite-team-outbox-store.js'

const outboxStoreByApi = new WeakMap<OpenClawPluginApi, SqliteTeamOutboxStore>()
export function createTeamOutboxStore(api: OpenClawPluginApi): SqliteTeamOutboxStore {
  const existingStore = outboxStoreByApi.get(api)
  if (existingStore) {
    return existingStore
  }
  const databasePath = readOutboxDatabasePath(api)
  const store = new SqliteTeamOutboxStore({
    databasePath,
    nowMs: () => Date.now(),
    randomId: () => randomUUID(),
  })
  outboxStoreByApi.set(api, store)
  api.lifecycle.registerRuntimeLifecycle({
    id: 'team-runtime-outbox-store',
    description: 'Close the Team outbox SQLite store during plugin runtime cleanup.',
    cleanup() {
      store.close()
      outboxStoreByApi.delete(api)
    },
  })
  return store
}

function readOutboxDatabasePath(api: OpenClawPluginApi): string {
  const storageRoot = readStorageRoot(api)
  return path.join(storageRoot, 'team-runtime', 'outbox.sqlite')
}

function readStorageRoot(api: OpenClawPluginApi): string {
  const config = api.pluginConfig
  if (config && typeof config === 'object' && !Array.isArray(config)) {
    const storageRoot = (config as Record<string, unknown>).storageRoot
    if (typeof storageRoot === 'string' && storageRoot.trim()) {
      return storageRoot.trim()
    }
  }
  return path.join(os.tmpdir(), 'matchaclaw-team-runtime')
}

