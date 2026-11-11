import type { AppJson, AppPluginContext } from '@matcha/app-plugins-sdk';
import { rm } from 'node:fs/promises';
import { workbookExportPdfRequestSchema } from '../../genoffice/apps/sheets/src/shared/desktop-api';
import { createIpcEvent, destroyWebContents, invokeIpc } from '../platform/electron-main';
import { withTemp, writeTemp } from '../platform/temp';
import { renderSheetsPdf } from './pdf';

const READ_CHANNELS = new Set([
  'workbook:read-range', 'workbook:read-formulas', 'workbook:read-row-outline',
  'workbook:read-media', 'workbook:read-pivot-definition', 'workbook:read-slicer-state',
  'workbook:read-redactions', 'workbook:list-external-links', 'workbook:list-connections', 'workbook:recalc'
]);

/** Original App headless load/layout, backed by this request's native session only. */
export async function xlsxToPdf(
  source: Uint8Array,
  context: Pick<AppPluginContext, 'packagePath' | 'rendering'>,
  options: { password?: string } = {},
  signal?: AbortSignal
): Promise<Uint8Array> {
  signal?.throwIfAborted();
  const [runtime, native] = await Promise.all([import('@matcha/sheets-main'), import('@matcha/sheets-save-runtime')]);
  const window = await runtime.createSheetsWindow({ includeAiHandlers: false });
  const event = createIpcEvent(window.webContents);
  const entry = native.sessionFor(event);
  let active = true;
  try {
    return await withTemp(async (directory) => {
      const path = await writeTemp(directory, 'workbook.xlsx', source);
      const file = await native.openWorkbookSession(entry.client, path, entry.sessions, options);
      const read = async (input: AppJson): Promise<AppJson> => {
        signal?.throwIfAborted();
        if (!active || !input || typeof input !== 'object' || Array.isArray(input)) throw new Error('Sheets PDF read is closed or invalid.');
        const { channel, arguments: args } = input;
        if (Object.keys(input).some((key) => key !== 'channel' && key !== 'arguments') || typeof channel !== 'string' || !READ_CHANNELS.has(channel) || !Array.isArray(args) || args.length !== 1) throw new Error('Sheets PDF allows only session-bound workbook reads.');
        const request = args[0];
        if (!request || typeof request !== 'object' || Array.isArray(request) || request.sessionId !== file.sessionId) throw new Error('Sheets PDF cannot read another workbook session.');
        if (channel === 'workbook:recalc' && (!Array.isArray(request.edits) || request.edits.length !== 0)) throw new Error('Sheets PDF cannot mutate workbook cells.');
        // Existing native handlers validate every range, media id and archive part.
        const result = await invokeIpc(channel, args, event);
        signal?.throwIfAborted();
        if (!active) throw new Error('Sheets PDF read has ended.');
        return result as AppJson;
      };
      const layout = await context.rendering.renderDocument({
        entry: 'renderer/sheets-pdf-worker.js',
        html: '<!doctype html><html><head><meta charset="utf-8"><link rel="stylesheet" href="renderer/sheets-pdf-worker.css"></head><body></body></html>',
        payload: { file: file as unknown as AppJson }
      }, signal, read);
      signal?.throwIfAborted();
      if (layout.mimeType !== 'application/json') throw new Error('Sheets layout returned an unexpected format.');
      const request = workbookExportPdfRequestSchema.parse(JSON.parse(Buffer.from(layout.data, 'base64').toString('utf8')));
      return renderSheetsPdf(request, (input) => context.rendering.renderPdf(input, signal));
    });
  } finally {
    active = false;
    for (const [id, session] of entry.sessions) {
      await entry.client.close(id).catch(() => {});
      await rm(session.snapshotPath, { force: true }).catch(() => {});
    }
    entry.sessions.clear();
    destroyWebContents(event.sender.id);
  }
}
