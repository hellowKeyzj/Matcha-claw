import { waitForCall } from '@/lib/call-log-await';
import {
  hostWikiCallResult,
  hostWikiDeleteSource,
  hostWikiImportFolder,
  hostWikiImportSource,
  hostWikiRefreshSources,
  hostWikiRescanSources,
} from '@/lib/host-api';
import { pickLocalDirectory, pickLocalFile } from '@/services/local-path-picker';
import type { WikiSourceActionContext } from './extensions';
import { summarizeDeleteSourceResult, summarizeSourceCallCounts } from './wiki-model';

export async function pickAndImportSource(context: WikiSourceActionContext): Promise<void> {
  const { projectId, t } = context;
  const path = await pickLocalFile({
    title: t('actions.pickSourceFileTitle'),
    buttonLabel: t('actions.importFileButton'),
  });
  if (!path) return;
  await context.mutate({
    label: 'import-source',
    projectBound: true,
    observeTasks: true,
    success: t('actions.importedSource'),
  }, async () => {
    const call = await hostWikiImportSource({ projectId, sourcePath: path })
      .then((receipt) => waitForCall(receipt, 'wiki', { timeoutMs: null }))
      .catch(() => { throw new Error(t('actions.resultUnconfirmed')); });
    if (call.command !== 'import-source' || call.detail.operation !== 'import-source' || call.status === 'unknown') {
      throw new Error(t('actions.resultUnconfirmed'));
    }
    if (call.status !== 'succeeded' || call.detail.outcome !== 'completed') {
      throw new Error(t('actions.failed', { label: 'import-source' }));
    }
    if (call.detail.counts === null) throw new Error(t('actions.resultUnconfirmed'));
    return summarizeSourceCallCounts(call.detail.counts, t('actions.importFileReceipt'));
  });
}

export async function pickAndImportFolder(context: WikiSourceActionContext): Promise<void> {
  const { projectId, t } = context;
  const path = await pickLocalDirectory({
    title: t('actions.pickSourceFolderTitle'),
    buttonLabel: t('actions.importFolderButton'),
  });
  if (!path) return;
  await context.mutate({
    label: 'import-folder',
    projectBound: true,
    observeTasks: true,
    success: t('actions.importedFolder'),
  }, async () => {
    const call = await hostWikiImportFolder({ projectId, folderPath: path })
      .then((receipt) => waitForCall(receipt, 'wiki', { timeoutMs: null }))
      .catch(() => { throw new Error(t('actions.resultUnconfirmed')); });
    if (call.command !== 'import-folder' || call.detail.operation !== 'import-folder' || call.status === 'unknown') {
      throw new Error(t('actions.resultUnconfirmed'));
    }
    if (call.status !== 'succeeded' || call.detail.outcome !== 'completed') {
      throw new Error(t('actions.failed', { label: 'import-folder' }));
    }
    if (call.detail.counts === null) throw new Error(t('actions.resultUnconfirmed'));
    return summarizeSourceCallCounts(call.detail.counts, t('actions.importFolderReceipt'));
  });
}

export async function rescanSources(context: WikiSourceActionContext): Promise<void> {
  const { t } = context;
  await context.mutate({ label: 'rescan', success: t('actions.rescanned') }, async () => {
    const call = await hostWikiRescanSources()
      .then((receipt) => waitForCall(receipt, 'wiki'))
      .catch(() => { throw new Error(t('actions.resultUnconfirmed')); });
    if (call.command !== 'rescan-sources' || call.detail.operation !== 'rescan-sources' || call.status === 'unknown') {
      throw new Error(t('actions.resultUnconfirmed'));
    }
    if (call.status !== 'succeeded' || call.detail.outcome !== 'completed') {
      throw new Error(t('actions.failed', { label: 'rescan-sources' }));
    }
  });
}

export async function deleteSourceAtPath(context: WikiSourceActionContext, path: string): Promise<void> {
  if (!path.trim()) return;
  const { t } = context;
  await context.mutate({ label: 'delete-source', success: t('actions.deletedSource') }, async () => {
    const call = await hostWikiDeleteSource({ sourcePath: path })
      .then((receipt) => waitForCall(receipt, 'wiki'))
      .catch(() => { throw new Error(t('actions.resultUnconfirmed')); });
    if (call.command !== 'delete-source' || call.detail.operation !== 'delete-source' || call.status === 'unknown') {
      throw new Error(t('actions.resultUnconfirmed'));
    }
    if (call.status !== 'succeeded' || call.detail.outcome !== 'completed') {
      throw new Error(t('actions.failed', { label: 'delete-source' }));
    }
    const result = await hostWikiCallResult({ callId: call.callId })
      .catch(() => { throw new Error(t('actions.resultUnconfirmed')); });
    if (result.callId !== call.callId || result.operation !== 'delete-source' || call.detail.counts === null
      || result.result.deletedPages.length !== call.detail.counts.deletedPages
      || result.result.updatedPages.length !== call.detail.counts.updatedPages
      || result.result.deletedMedia.length !== call.detail.counts.deletedMedia) {
      throw new Error(t('actions.resultUnconfirmed'));
    }
    return summarizeDeleteSourceResult(result.result, t('actions.deleteSourceReceipt'));
  });
}

export async function refreshSources(context: WikiSourceActionContext): Promise<void> {
  const { projectId, t } = context;
  await context.mutate({
    label: 'refresh-sources',
    projectBound: true,
    observeTasks: true,
    success: t('actions.refreshedSources'),
  }, async () => {
    const call = await hostWikiRefreshSources({ projectId })
      .then((receipt) => waitForCall(receipt, 'wiki', { timeoutMs: null }))
      .catch(() => { throw new Error(t('actions.resultUnconfirmed')); });
    if (call.command !== 'refresh-sources' || call.detail.operation !== 'refresh-sources' || call.status === 'unknown') {
      throw new Error(t('actions.resultUnconfirmed'));
    }
    if (call.status !== 'succeeded' || call.detail.outcome !== 'completed') {
      throw new Error(t('actions.failed', { label: 'refresh-sources' }));
    }
    if (call.detail.counts === null) throw new Error(t('actions.resultUnconfirmed'));
    return summarizeSourceCallCounts(call.detail.counts, t('actions.refreshSourcesReceipt'));
  });
}
