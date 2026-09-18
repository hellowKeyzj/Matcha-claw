type ProviderRefreshTask = false | (() => Promise<void>);

interface ProviderPostMutationRefreshOptions {
  providerSnapshotReason?: string;
  refreshProviderSnapshot?: ProviderRefreshTask;
  refreshProviderModelCatalog?: ProviderRefreshTask;
  refreshCapabilityRouting?: ProviderRefreshTask;
}

function addRefreshTask(
  tasks: Promise<void>[],
  refresh: ProviderRefreshTask | undefined,
  defaultRefresh: () => Promise<void>,
): void {
  if (refresh === false) return;
  tasks.push((refresh ?? defaultRefresh)());
}

async function refreshProviderSnapshot(reason: string): Promise<void> {
  const { useProviderStore } = await import('@/stores/providers');
  await useProviderStore.getState().refreshProviderSnapshot({
    trigger: 'reconcile',
    reason,
  });
}

async function refreshProviderModelCatalog(): Promise<void> {
  const { useProviderModelCatalogStore } = await import('@/stores/provider-model-catalog');
  await useProviderModelCatalogStore.getState().refresh();
}

async function refreshCapabilityRouting(): Promise<void> {
  const { useCapabilityRoutingStore } = await import('@/stores/capability-routing');
  await useCapabilityRoutingStore.getState().refresh();
}

async function refreshSubagentAvailableModels(): Promise<void> {
  const { useSubagentsStore } = await import('@/stores/subagents');
  await useSubagentsStore.getState().loadAvailableModels({ force: true });
}

export async function refreshProviderPostMutationProjections(
  options: ProviderPostMutationRefreshOptions = {},
): Promise<void> {
  const providerSnapshotReason = options.providerSnapshotReason ?? 'provider_post_mutation';
  const tasks: Promise<void>[] = [];

  addRefreshTask(
    tasks,
    options.refreshProviderSnapshot,
    () => refreshProviderSnapshot(providerSnapshotReason),
  );
  addRefreshTask(tasks, options.refreshProviderModelCatalog, refreshProviderModelCatalog);
  addRefreshTask(tasks, options.refreshCapabilityRouting, refreshCapabilityRouting);
  tasks.push(refreshSubagentAvailableModels());

  await Promise.all(tasks);
}
