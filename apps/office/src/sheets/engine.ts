import { readFile, rm } from 'node:fs/promises';
import type { SheetRead, WriteOutcome, CellInput } from '../../genoffice/packages/cli/src/formats/xlsx';
import type { DslOutcome } from '../../genoffice/packages/cli/src/formats/xlsx-dsl';
import type { WorkbookCheck } from '../../genoffice/packages/cli/src/formats/xlsx-check';
import { withTemp, writeTemp } from '../platform/temp';
export { xlsxToPdf } from './pdf-backend';

export async function openCsvWorkbook(source: Uint8Array): Promise<Uint8Array> {
  const [{ decodeCsvBuffer }, { csvToXlsxBufferForOpen }] = await Promise.all([
    import('../../genoffice/packages/xlsx-gateway/src/gateway/csv-import'),
    import('../../genoffice/packages/xlsx-gateway/src/gateway/csv-import-xlsx')
  ]);
  const { sheetsCsvCharset } = await import('./runtime');
  return new Uint8Array((await csvToXlsxBufferForOpen(decodeCsvBuffer(source, sheetsCsvCharset()))).buffer);
}

export async function createXlsxFromCsv(csv: Uint8Array): Promise<Uint8Array> {
  const xlsx = await import('../../genoffice/packages/cli/src/formats/xlsx');
  const table = xlsx.csvTable(csv, 'Sheet1');
  const edits = xlsx.cellEditsFromTable(table.name, table.rows, table.formats ?? {});
  const blank = await xlsx.blankWorkbook(table.name);
  return withTemp(async (directory) => {
    const output = `${directory}/output.xlsx`;
    await xlsx.writeWorkbook(blank, edits, output, {});
    return new Uint8Array(await readFile(output));
  });
}

export async function createXlsxFromOps(ops: readonly unknown[]): Promise<{ bytes: Uint8Array; outcome: DslOutcome }> {
  const xlsx = await import('../../genoffice/packages/cli/src/formats/xlsx');
  const blank = await xlsx.blankWorkbook();
  return applyXlsxOps(blank, ops);
}

export async function applyXlsxOps(
  source: Uint8Array,
  ops: readonly unknown[]
): Promise<{ bytes: Uint8Array; outcome: DslOutcome }> {
  const [xlsx, dsl] = await Promise.all([
    import('../../genoffice/packages/cli/src/formats/xlsx'),
    import('../../genoffice/packages/cli/src/formats/xlsx-dsl')
  ]);
  const buffer = Buffer.from(source);
  return withTemp(async (directory) => {
    const sourcePath = await writeTemp(directory, 'source.xlsx', buffer);
    const outcome = await dsl.runWorkbookDsl(buffer, [...ops], undefined, undefined, { sourcePath });
    const output = `${directory}/output.xlsx`;
    await xlsx.writeWorkbook(buffer, outcome.edits, output, {
      plan: outcome.sheetPlan,
      structuralOps: outcome.structuralOps,
      renames: outcome.renames,
      gateway: outcome.gateway
    });
    return { bytes: new Uint8Array(await readFile(output)), outcome };
  });
}

export async function applyXlsxCells(
  source: Uint8Array,
  cells: readonly unknown[],
  sheet?: string
): Promise<{ bytes: Uint8Array; outcome: WriteOutcome }> {
  const xlsx = await import('../../genoffice/packages/cli/src/formats/xlsx');
  const edits = xlsx.cellEditsFromInputs(cells as CellInput[], sheet ?? 'Sheet1');
  const buffer = Buffer.from(source);
  return withTemp(async (directory) => {
    const output = `${directory}/output.xlsx`;
    const outcome = await xlsx.writeWorkbook(buffer, edits, output, {});
    return { bytes: new Uint8Array(await readFile(output)), outcome };
  });
}

export async function readXlsx(
  source: Uint8Array,
  options: { sheet?: string; range?: string }
): Promise<SheetRead> {
  const xlsx = await import('../../genoffice/packages/cli/src/formats/xlsx');
  return withTemp(async (directory) => {
    const path = await writeTemp(directory, 'document.xlsx', source);
    return xlsx.readSheet(path, { sheet: options.sheet, range: options.range, maxRows: 200 });
  });
}

export async function checkXlsx(source: Uint8Array): Promise<WorkbookCheck> {
  const check = await import('../../genoffice/packages/cli/src/formats/xlsx-check');
  return check.checkWorkbook(source);
}

export async function xlsxToCsv(source: Uint8Array, sheet?: string): Promise<{ csv: string; sheet: string }> {
  const xlsx = await import('../../genoffice/packages/cli/src/formats/xlsx');
  return withTemp(async (directory) => {
    const path = await writeTemp(directory, 'document.xlsx', source);
    const result = await xlsx.sheetToCsv(path, { sheet });
    return { csv: result.csv, sheet: result.sheet };
  });
}

export async function importWorkbook(
  source: Uint8Array,
  extension: string
): Promise<{ bytes: Uint8Array; detail: Readonly<Record<string, unknown>> }> {
  const format = extension.toLowerCase().replace(/^\./, '');
  if (!['xlsx', 'xlsm', 'xls', 'csv', 'tsv', 'ods', 'ots'].includes(format)) throw new Error('Unsupported spreadsheet format.');
  const [native, { sessionFor }, { createIpcEvent, destroyWebContents }] = await Promise.all([
    (await import('./runtime')).sheetsRuntime(), import('@matcha/sheets-save-runtime'), import('../platform/electron-main')
  ]);
  const { prepareWorkbookForOpen, openWorkbookSession } = await import('@matcha/sheets-save-runtime');
  const window = await native.createSheetsWindow({ includeAiHandlers: false });
  const event = createIpcEvent(window.webContents);
  const entry = sessionFor(event);
  try {
    return await withTemp(async (directory) => {
      const path = await writeTemp(directory, `source.${format}`, source);
      const prepared = await prepareWorkbookForOpen(entry.client, path, undefined, undefined, { skipRecoveryPrompt: true });
      if (!prepared) throw new Error('Spreadsheet import was cancelled.');
      try {
        const file = await openWorkbookSession(entry.client, prepared.openPath, entry.sessions);
        return {
          bytes: new Uint8Array(await readFile(prepared.openPath)),
          detail: { sourceFormat: format, sheets: file.sheets.length, converted: !['xlsx', 'xlsm'].includes(format),
            ...(format === 'xlsm' ? { macrosPreserved: true } : {}),
            ...(['xls', 'ods', 'ots'].includes(format) ? { lossy: true, warning: 'Legacy conversion preserves values and formulas; formatting may be lost.' } : {}),
            ...(['csv', 'tsv'].includes(format) ? { copy: 'xlsx', empty: prepared.emptyCsv === true } : {}) }
        };
      } finally {
        for (const [id, session] of entry.sessions) {
          await entry.client.close(id).catch(() => {});
          await rm(session.snapshotPath, { force: true }).catch(() => {});
        }
        entry.sessions.clear();
        if (prepared.importTempDir) await rm(prepared.importTempDir, { recursive: true, force: true });
      }
    });
  } finally { destroyWebContents(event.sender.id); }
}

export async function sheetGuide(): Promise<{ ops: readonly string[] }> {
  const dsl = await import('../../genoffice/packages/cli/src/formats/xlsx-dsl');
  return { ops: dsl.SUPPORTED_DSL_OPS };
}
