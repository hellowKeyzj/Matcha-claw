import type { BrowserUtilityRequest } from '../../../packages/openclaw-browser-relay-plugin/src/browser-action-contract';
import type { IabJsonObject } from '../../../src/types/desktop/iab';
import type { AutomationContext } from './automation-port';
import type { IabAutomationPage, Operation } from './automation-page';
import { iabError } from './error';

export async function armDownload(page: IabAutomationPage, request: Extract<BrowserUtilityRequest, { kind: 'download' }>, context: AutomationContext, leaseId: string, operation: Operation): Promise<{ completion: Promise<IabJsonObject>; cancel(error: unknown): void }> {
  const directory = await context.prepareDownload(request.dir, request.savePath, operation.signal);
  let entry: { guid: string; url: string; filename: string } | undefined;
  let complete!: (value: IabJsonObject) => void;
  let rejectCompletion!: (error: unknown) => void;
  let failure: unknown;
  const fail = (error: unknown) => { failure = error; rejectCompletion(error); };
  let stopped = false;
  let completed = false;
  let saving: Promise<void> | undefined;
  const completion = new Promise<IabJsonObject>((resolve, reject) => { complete = resolve; rejectCompletion = reject; });
  void completion.catch(() => {});
  const abort = () => fail(operation.signal.reason);
  operation.signal.addEventListener('abort', abort, { once: true });
  const stop = page.executor.onEvent((event) => {
    if (event.method === 'IAB.epochInvalidated') { fail(iabError('IAB_DOWNLOAD_INTERRUPTED', 'Download interrupted by physical browser epoch change')); return; }
    if (event.method === 'Page.downloadWillBegin') {
      const guid = String(event.params.guid ?? '');
      if (!/^[A-Za-z0-9-]+$/u.test(guid)) { fail(iabError('IAB_DOWNLOAD_GUID_INVALID', 'Invalid native download identifier')); return; }
      if (entry && entry.guid !== guid) { fail(iabError('DOWNLOAD_CAPTURE_AMBIGUOUS', 'Multiple downloads started in this tab; no file can be selected safely. Input may already have been dispatched; inspect downloads and do not repeat the input automatically.')); return; }
      entry = { guid, url: String(event.params.url ?? ''), filename: String(event.params.suggestedFilename ?? 'download') };
    }
    if (event.method !== 'Page.downloadProgress' || !entry || event.params.guid !== entry.guid || event.params.state === 'inProgress' || completed) return;
    completed = true;
    if (event.params.state === 'canceled') { complete({ canceled: true, url: entry.url, savePath: '', bytes: Number(event.params.receivedBytes ?? 0) }); return; }
    const captured = entry;
    saving = (async () => {
      await page.pause(150, operation);
      operation.signal.throwIfAborted(); context.assertCurrent();
      if (failure) throw failure;
      if (stopped) return;
      const bytes = Number(event.params.receivedBytes ?? 0);
      const destination = await context.finishDownload(leaseId, { guid: captured.guid, filename: captured.filename, directory, savePath: request.savePath, bytes }, operation.signal);
      complete({ url: captured.url, suggestedFilename: captured.filename, savePath: destination, savedTo: destination, bytes, canceled: false });
    })().catch(fail);
  });
  const cleanup = () => { stopped = true; stop(); operation.signal.removeEventListener('abort', abort); context.releaseDownload(leaseId); };
  try {
    operation.signal.throwIfAborted();
    await page.send('Page.setDownloadBehavior', { behavior: 'allowAndName', downloadPath: directory, eventsEnabled: true }, operation);
  } catch (error) { cleanup(); throw error; }
  return { completion: completion.finally(async () => { cleanup(); await saving; }), cancel: fail };
}
