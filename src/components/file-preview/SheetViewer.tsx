import { useEffect, useMemo, useState } from 'react';
import { ChevronLeft, ChevronRight } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { LoadingSpinner } from '@/components/common/LoadingSpinner';
import { Button } from '@/components/ui/button';
import { StructuredTablePreview } from '@/pages/Chat/components/StructuredTablePreview';
import { hostFileReadBinary, type WorkspaceFileContext } from '@/lib/host-api';
import { cn } from '@/lib/utils';
import type { SessionIdentity } from '../../../runtime-host/shared/runtime-address';

const SHEET_MAX_BYTES = 50 * 1024 * 1024;
const ROWS_PER_PAGE = 200;

interface SheetViewerProps {
  filePath: string;
  sessionIdentity?: SessionIdentity;
  workspaceContext?: WorkspaceFileContext;
  className?: string;
}

interface SheetSnapshot {
  name: string;
  rowCount: number;
  columnCount: number;
  readRows: () => string[][];
}

interface XlsxSheetLike {
  [key: string]: unknown;
}

interface XlsxWorkbookLike {
  SheetNames: string[];
  Sheets: Record<string, XlsxSheetLike | undefined>;
}

interface XlsxModuleLike {
  read: (data: ArrayBuffer, options: { type: 'array'; cellDates: boolean }) => XlsxWorkbookLike;
  utils: {
    sheet_to_json: (
      worksheet: XlsxSheetLike,
      options: { header: 1; defval: string; blankrows: boolean; raw: boolean },
    ) => unknown[][];
  };
}

type SheetLoadState =
  | { status: 'loading' }
  | { status: 'ready'; sheets: SheetSnapshot[] }
  | { status: 'tooLarge'; size?: number }
  | { status: 'error'; message: string };

function decodeBase64ToArrayBuffer(data: string): ArrayBuffer {
  const binary = window.atob(data);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes.buffer;
}

function formatCell(value: unknown): string {
  if (value == null) {
    return '';
  }
  if (value instanceof Date) {
    return value.toISOString().slice(0, 10);
  }
  if (typeof value === 'number') {
    return Number.isInteger(value)
      ? String(value)
      : value.toLocaleString(undefined, { maximumFractionDigits: 6 });
  }
  if (typeof value === 'boolean') {
    return value ? 'TRUE' : 'FALSE';
  }
  return String(value);
}

export function SheetViewer({
  filePath,
  sessionIdentity,
  workspaceContext,
  className,
}: SheetViewerProps) {
  const { t } = useTranslation('chat');
  const [state, setState] = useState<SheetLoadState>({ status: 'loading' });
  const [sheetIndex, setSheetIndex] = useState(0);
  const [page, setPage] = useState(0);

  useEffect(() => {
    let cancelled = false;
    setState({ status: 'loading' });
    setSheetIndex(0);
    setPage(0);

    void (async () => {
      try {
        if (!sessionIdentity) {
          throw new Error('SessionIdentity is required');
        }
        const result = await hostFileReadBinary({
          path: filePath,
          maxBytes: SHEET_MAX_BYTES,
          sessionIdentity,
          ...workspaceContext,
        });
        if (cancelled) {
          return;
        }
        if (!result.ok || !result.data) {
          if (result.error === 'tooLarge') {
            setState({ status: 'tooLarge', size: result.size });
            return;
          }
          setState({ status: 'error', message: String(result.error ?? 'unknown') });
          return;
        }
        const xlsx = await import('xlsx') as unknown as XlsxModuleLike;
        const workbook = xlsx.read(decodeBase64ToArrayBuffer(result.data), {
          type: 'array',
          cellDates: true,
        });
        const sheets: SheetSnapshot[] = workbook.SheetNames.map((name: string) => {
          const worksheet = workbook.Sheets[name];
          if (!worksheet) {
            return {
              name,
              rowCount: 0,
              columnCount: 0,
              readRows: () => [],
            };
          }
          const rows = xlsx.utils.sheet_to_json(worksheet, {
            header: 1,
            defval: '',
            blankrows: false,
            raw: true,
          });
          const maxColumns = rows.reduce((max: number, row: unknown[]) => Math.max(max, Array.isArray(row) ? row.length : 0), 0);
          return {
            name,
            rowCount: rows.length,
            columnCount: maxColumns,
            readRows: () => rows.map((row: unknown[]) => (
              Array.from({ length: maxColumns }, (_, index) => formatCell(row[index]))
            )),
          };
        });
        setState({ status: 'ready', sheets });
      } catch (error) {
        if (cancelled) {
          return;
        }
        setState({
          status: 'error',
          message: error instanceof Error ? error.message : String(error),
        });
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [filePath, sessionIdentity, workspaceContext]);

  const activeSheet = state.status === 'ready' ? state.sheets[sheetIndex] ?? null : null;
  const totalRows = activeSheet?.rowCount ?? 0;
  const totalPages = Math.max(1, Math.ceil(totalRows / ROWS_PER_PAGE));
  const visibleRows = useMemo(() => {
    if (!activeSheet) {
      return [];
    }
    const rows = activeSheet.readRows();
    const start = page * ROWS_PER_PAGE;
    return rows.slice(start, start + ROWS_PER_PAGE);
  }, [activeSheet, page]);

  if (state.status === 'loading') {
    return (
      <div className={cn('flex h-full items-center justify-center', className)}>
        <LoadingSpinner />
      </div>
    );
  }

  if (state.status === 'tooLarge') {
    return (
      <div className={cn('flex h-full items-center justify-center px-6 text-center text-sm text-muted-foreground', className)}>
        {t('artifacts.previewTooLarge')}
      </div>
    );
  }

  if (state.status === 'error') {
    return (
      <div className={cn('flex h-full items-center justify-center px-6 text-center text-sm text-destructive', className)}>
        {t('artifacts.previewLoadFailed', { error: state.message })}
      </div>
    );
  }

  return (
    <div data-testid="sheet-viewer" className={cn('flex h-full min-h-0 flex-col overflow-hidden', className)}>
      <div className="flex items-center justify-between gap-3 border-b border-border/40 px-3 py-2">
        <div className="flex min-w-0 items-center gap-2 overflow-x-auto">
          {state.sheets.map((sheet, index) => (
            <button
              key={`${sheet.name}:${index}`}
              type="button"
              onClick={() => {
                setSheetIndex(index);
                setPage(0);
              }}
              className={cn(
                'shrink-0 rounded-full border px-3 py-1 text-xs transition-colors',
                index === sheetIndex
                  ? 'border-border/70 bg-background text-foreground'
                  : 'border-transparent bg-muted/45 text-muted-foreground hover:bg-muted/65',
              )}
            >
              {sheet.name || t('artifacts.previewUnnamedSheet', { index: index + 1 })}
            </button>
          ))}
        </div>
        <div className="flex shrink-0 items-center gap-1">
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className="h-7 w-7 rounded-md"
            onClick={() => setPage((current) => Math.max(0, current - 1))}
            disabled={page === 0}
          >
            <ChevronLeft className="h-4 w-4" />
          </Button>
          <span className="text-xs text-muted-foreground">
            {page + 1} / {totalPages}
          </span>
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className="h-7 w-7 rounded-md"
            onClick={() => setPage((current) => Math.min(totalPages - 1, current + 1))}
            disabled={page >= totalPages - 1}
          >
            <ChevronRight className="h-4 w-4" />
          </Button>
        </div>
      </div>
      <div className="min-h-0 flex-1 overflow-auto p-3">
        {visibleRows.length === 0 ? (
          <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
            {t('artifacts.previewEmptySheet')}
          </div>
        ) : (
          <StructuredTablePreview rows={visibleRows} />
        )}
      </div>
    </div>
  );
}
