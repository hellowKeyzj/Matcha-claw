import { dialog, ipcMain } from 'electron';
import { writeFile } from 'node:fs/promises';
import type { DiagnosticsArchiveTransport } from '../runtime-host-delivery/transport/diagnostics';
import { getE2EDiagnosticsArchiveSavePath } from '@electron/e2e-fixture-loader';

const CHANNEL = 'diagnostics:exportArchive';

type DiagnosticsExportResult = Readonly<{ status: 'saved' | 'cancelled' | 'failed' }>;

export type DiagnosticsExportDependencies = Readonly<{
  transport: Pick<DiagnosticsArchiveTransport, 'download'>;
  showSaveDialog: typeof dialog.showSaveDialog;
  writeFile: typeof writeFile;
  getE2ESavePath: () => Promise<string | null>;
}>;

export function registerDiagnosticsExportHandler(
  dependencies: DiagnosticsExportDependencies,
): void {
  ipcMain.handle(CHANNEL, async (_, input: unknown): Promise<DiagnosticsExportResult> => {
    const archiveId = decodeArchiveId(input);
    if (!archiveId) return { status: 'failed' };

    try {
      const e2eFilePath = await dependencies.getE2ESavePath();
      const saveResult = e2eFilePath
        ? { canceled: false, filePath: e2eFilePath }
        : await dependencies.showSaveDialog({
          title: 'Save diagnostics archive',
          defaultPath: `diagnostics-${archiveId}.zip`,
          filters: [{ name: 'ZIP archive', extensions: ['zip'] }],
        });
      if (saveResult.canceled || !saveResult.filePath) return { status: 'cancelled' };

      const download = await dependencies.transport.download(archiveId);
      if (download.status !== 200) return { status: 'failed' };
      await dependencies.writeFile(saveResult.filePath, download.body);
      return { status: 'saved' };
    } catch {
      return { status: 'failed' };
    }
  });
}

export function createDiagnosticsExportDependencies(
  transport: Pick<DiagnosticsArchiveTransport, 'download'>,
): DiagnosticsExportDependencies {
  return {
    transport,
    showSaveDialog: dialog.showSaveDialog,
    writeFile,
    getE2ESavePath: getE2EDiagnosticsArchiveSavePath,
  };
}

function decodeArchiveId(value: unknown): string | null {
  if (!isRecord(value) || !hasExactKeys(value, ['archiveId']) || !isArchiveId(value.archiveId)) {
    return null;
  }
  return value.archiveId;
}

function isArchiveId(value: unknown): value is string {
  return typeof value === 'string' && /^[a-f0-9]{32}$/.test(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function hasExactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const keys = Object.keys(value);
  return keys.length === expected.length && expected.every((key) => Object.hasOwn(value, key));
}
