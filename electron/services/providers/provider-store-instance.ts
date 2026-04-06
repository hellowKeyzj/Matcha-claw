// Lazy-load electron-store (ESM) only in main process context.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let providerStore: any = null;

export async function getClawXProviderStore() {
  if (!providerStore) {
    const Store = (await import('electron-store')).default;
    providerStore = new Store({
      name: 'clawx-providers',
      defaults: {
        schemaVersion: 1,
        providers: {} as Record<string, unknown>,
        apiKeys: {} as Record<string, string>,
        providerSecrets: {} as Record<string, unknown>,
        defaultProvider: null as string | null,
        defaultProviderAccountId: null as string | null,
      },
    });
  }
  return providerStore;
}

export async function ensureProviderStoreReady(): Promise<void> {
  const store = await getClawXProviderStore();
  const schemaVersion = Number(store.get('schemaVersion') ?? 0);
  if (schemaVersion < 1) {
    store.set('schemaVersion', 1);
  }
}

