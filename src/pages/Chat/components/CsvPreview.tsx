import { memo, useCallback, useMemo, useState } from 'react';
import { Check, Copy, TableProperties } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { StructuredTablePreview } from './StructuredTablePreview';

interface CsvPreviewProps {
  csv: string;
}

function parseCsvRows(csv: string): string[][] | null {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let inQuotes = false;

  for (let index = 0; index < csv.length; index += 1) {
    const char = csv[index];
    if (inQuotes) {
      if (char === '"') {
        if (csv[index + 1] === '"') {
          field += '"';
          index += 1;
        } else {
          inQuotes = false;
        }
        continue;
      }
      field += char;
      continue;
    }

    if (char === '"') {
      inQuotes = true;
      continue;
    }
    if (char === ',') {
      row.push(field);
      field = '';
      continue;
    }
    if (char === '\r') {
      row.push(field);
      field = '';
      rows.push(row);
      row = [];
      if (csv[index + 1] === '\n') {
        index += 1;
      }
      continue;
    }
    if (char === '\n') {
      row.push(field);
      field = '';
      rows.push(row);
      row = [];
      continue;
    }
    field += char;
  }

  if (inQuotes) {
    return null;
  }

  row.push(field);
  rows.push(row);

  while (rows.length > 0) {
    const lastRow = rows[rows.length - 1];
    if (lastRow.length !== 1 || lastRow[0] !== '') {
      break;
    }
    rows.pop();
  }

  return rows.length > 0 ? rows : null;
}

export const CsvPreview = memo(function CsvPreview({
  csv,
}: CsvPreviewProps) {
  const [copied, setCopied] = useState(false);
  const rows = useMemo(() => parseCsvRows(csv), [csv]);

  const handleCopy = useCallback(() => {
    void navigator.clipboard.writeText(csv);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }, [csv]);

  if (!rows) {
    return (
      <div className="overflow-hidden rounded-[18px] border border-border/45 bg-background/68 shadow-sm backdrop-blur-sm">
        <div className="flex items-center justify-between border-b border-border/45 px-3 py-2">
          <div className="flex items-center gap-2 text-xs text-muted-foreground">
            <TableProperties className="h-3.5 w-3.5" />
            <span className="font-medium text-foreground">CSV</span>
          </div>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="h-7 gap-1.5 rounded-full border border-border/40 bg-background/72 px-2.5 text-[11px] text-muted-foreground shadow-none hover:bg-background/88 hover:text-foreground"
            onClick={handleCopy}
          >
            {copied ? <Check className="h-3.5 w-3.5 text-green-500" /> : <Copy className="h-3.5 w-3.5" />}
            <span>{copied ? 'Copied' : 'Copy CSV'}</span>
          </Button>
        </div>
        <pre className="overflow-x-auto px-3 py-3 text-[11px] leading-6 text-foreground">
          <code>{csv}</code>
        </pre>
      </div>
    );
  }

  const columnCount = rows.reduce((max, row) => Math.max(max, row.length), 0);
  const normalizedRows = rows.map((currentRow) => Array.from({ length: columnCount }, (_, index) => currentRow[index] ?? ''));

  return (
    <StructuredTablePreview
      rows={normalizedRows}
      copyText={csv}
      copyAriaLabel="复制 CSV"
    />
  );
});
