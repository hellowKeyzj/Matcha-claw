import { LocaleType } from '@univerjs/core';
import { UniverSheetsCorePreset } from '@univerjs/preset-sheets-core';
import enUS from '@univerjs/preset-sheets-core/locales/en-US';
import { createUniver } from '../../genoffice/apps/sheets/src/renderer/create-univer';
import { SetRangeValuesMutation } from '@univerjs/sheets';
import { loadWorkbookSkeleton } from '../../genoffice/apps/sheets/src/renderer/univer-sync';
import type { WorkbookFile, WorkbookPickSelection } from '../../genoffice/apps/sheets/src/shared/desktop-api';
import { sheetsLabels } from './labels';

/** Separate read-only grid, never a second App, journal, save or library owner. */
export function selectLinkedRange(
  requestId: string,
  load: () => Promise<WorkbookFile>,
  release: () => Promise<unknown>,
  onPick: (selection: WorkbookPickSelection) => void
): () => void {
  const focus = document.activeElement as HTMLElement | null;
  const dialog = document.createElement('dialog');
  dialog.className = 'office-dialog matcha-sheets-selection';
  const labels = sheetsLabels();
  const heading = document.createElement('h2');
  heading.textContent = labels.selectRange;
  const message = document.createElement('p');
  message.setAttribute('role', 'status');
  message.textContent = labels.loading;
  const host = document.createElement('div');
  host.id = `office-range-${requestId}`;
  host.style.cssText = 'height:60vh;min-height:260px;width:80vw;max-width:1100px;position:relative';
  const cancel = document.createElement('button');
  cancel.textContent = labels.cancel;
  const confirm = document.createElement('button');
  confirm.textContent = labels.selectRange;
  confirm.disabled = true;
  dialog.append(heading, message, host, cancel, confirm);
  document.body.append(dialog);
  dialog.showModal();
  let closed = false;
  let selectionInteraction = false;
  host.addEventListener('pointerdown', () => { selectionInteraction = true; }, true);
  host.addEventListener('keydown', event => {
    if (['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Home', 'End', 'PageUp', 'PageDown', 'Tab', 'Enter', ' '].includes(event.key)) selectionInteraction = true;
  }, true);
  let reading = false;
  let nextRange: (() => Promise<void>) | undefined;
  let runtime: ReturnType<typeof createUniver> | undefined;
  let selection: WorkbookPickSelection | undefined;
  const subscriptions: { dispose(): void }[] = [];
  const dispose = () => {
    if (closed) return;
    closed = true;
    window.removeEventListener('pagehide', dispose);
    for (const subscription of subscriptions) subscription.dispose();
    runtime?.univer.dispose();
    dialog.close(); dialog.remove(); focus?.focus();
    void release().catch(console.error);
  };
  cancel.onclick = dispose;
  dialog.addEventListener('cancel', event => { event.preventDefault(); dispose(); });
  window.addEventListener('pagehide', dispose, { once: true });
  confirm.onclick = () => {
    if (!selection) return;
    try { onPick(selection); } finally { dispose(); }
  };
  void (async () => {
    const file = await load();
    if (closed) { await release(); return; }
    runtime = createUniver({ locale: LocaleType.EN_US, locales: { [LocaleType.EN_US]: enUS }, presets: [UniverSheetsCorePreset({ container: host.id, header: false, toolbar: false, contextMenu: false, formulaBar: false })] });
    loadWorkbookSkeleton(runtime, file);
    const book = runtime.univerAPI.getActiveWorkbook();
    if (!book) throw new Error(labels.failed);
    await book.getWorkbookPermission().setReadOnly();
    if (closed) return;
    const loadRange = (sheet: NonNullable<ReturnType<typeof book.getActiveSheet>>, startRow = 0, startColumn = 0) => {
      nextRange = async () => {
        if (closed) return;
        const range = { startRow, endRow: Math.min(1_048_575, startRow + 79), startColumn, endColumn: Math.min(16_383, startColumn + 29) };
        const result = await window.desktopApi.readWorkbookRange({ sessionId: file.sessionId, sheetId: sheet.getSheetId(), range });
        if (closed) return;
        const meta = file.sheets.find(item => item.id === sheet.getSheetId());
        if (!meta) throw new Error(labels.failed);
        // Internal loader mutation bypasses user edit commands; viewer permissions stay enabled throughout.
        const values: Record<number, Record<number, { v: string | number | boolean | null }>> = {};
        for (const cell of result.cells) (values[cell.row] ??= {})[cell.column] = { v: cell.value };
        runtime!.univerAPI.syncExecuteCommand(SetRangeValuesMutation.id, { unitId: book.getId(), subUnitId: sheet.getSheetId(), cellValue: values });
        message.textContent = '';
      };
      if (reading) return;
      reading = true;
      void (async () => {
        try {
          while (nextRange && !closed) { const pending = nextRange; nextRange = undefined; await pending(); }
        } catch (error) { message.textContent = `${labels.failed}: ${String(error)}`; }
        finally { reading = false; }
      })();
    };
    const active = book.getActiveSheet();
    if (active) loadRange(active);
    subscriptions.push(runtime.univerAPI.addEvent(runtime.univerAPI.Event.Scroll, event => {
      const position = event as { sheetViewStartRow?: number; sheetViewStartColumn?: number };
      loadRange(event.worksheet, Math.max(0, position.sheetViewStartRow ?? 0), Math.max(0, position.sheetViewStartColumn ?? 0));
    }));
    subscriptions.push(runtime.univerAPI.addEvent(runtime.univerAPI.Event.ActiveSheetChanged, () => {
      selection = undefined;
      selectionInteraction = false;
      confirm.disabled = true;
      const sheet = book.getActiveSheet();
      if (sheet) loadRange(sheet);
    }));
    subscriptions.push(runtime.univerAPI.addEvent(runtime.univerAPI.Event.SelectionMoveEnd, event => {
      const range = event.selections[0];
      if (!range || closed) return;
      if (!selectionInteraction) { loadRange(event.worksheet); return; }
      selectionInteraction = false;
      selection = { pickId: requestId, sheetName: event.worksheet.getSheetName(), startRow: range.startRow, endRow: range.endRow, startColumn: range.startColumn, endColumn: range.endColumn, ...(range.rangeType === undefined ? {} : { rangeType: range.rangeType }) };
      confirm.disabled = false;
      loadRange(event.worksheet, Math.max(0, range.startRow), Math.max(0, range.startColumn));
    }));
  })().catch(error => { if (!closed) message.textContent = `${labels.failed}: ${String(error)}`; });
  return dispose;
}
