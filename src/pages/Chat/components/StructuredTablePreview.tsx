import { memo, useCallback, useState } from 'react';
import { Check, Copy } from 'lucide-react';

interface StructuredTablePreviewProps {
  rows: string[][];
  copyText?: string;
  copyAriaLabel?: string;
}

export const StructuredTablePreview = memo(function StructuredTablePreview({
  rows,
  copyText,
  copyAriaLabel = '复制表格',
}: StructuredTablePreviewProps) {
  const [copied, setCopied] = useState(false);
  const header = rows[0] ?? [];
  const bodyRows = rows.slice(1);
  const columnCount = rows.reduce((max, row) => Math.max(max, row.length), 0);
  const normalizedHeader = Array.from({ length: columnCount }, (_, index) => header[index] ?? '');
  const normalizedBodyRows = bodyRows.map((row) => Array.from({ length: columnCount }, (_, index) => row[index] ?? ''));
  const handleCopy = useCallback(() => {
    if (!copyText) {
      return;
    }
    void navigator.clipboard.writeText(copyText);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }, [copyText]);

  return (
    <div className="overflow-hidden rounded-[18px] border border-border/45 bg-background/68 shadow-sm backdrop-blur-sm">
      {copyText ? (
        <div className="flex items-center justify-end border-b border-border/45 px-2 py-1.5">
          <button
            type="button"
            className="inline-flex h-6 w-6 items-center justify-center rounded-full border border-transparent text-muted-foreground transition-colors hover:border-border/40 hover:bg-background/80 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/20"
            aria-label={copyAriaLabel}
            onClick={handleCopy}
          >
            {copied ? <Check className="h-3.5 w-3.5 text-green-500" /> : <Copy className="h-3.5 w-3.5" />}
          </button>
        </div>
      ) : null}
      <div className="max-h-[28rem] overflow-auto">
        <table className="min-w-full border-collapse text-left text-[11px]">
          <thead className="sticky top-0 bg-background/92 backdrop-blur">
            <tr>
              {normalizedHeader.map((cell, index) => (
                <th
                  key={`head:${index}`}
                  className="border-b border-r border-border/45 px-3 py-2.5 font-semibold tracking-[-0.01em] text-foreground last:border-r-0"
                >
                  {cell}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {normalizedBodyRows.map((row, rowIndex) => (
              <tr key={`row:${rowIndex}`} className="odd:bg-background/36">
                {row.map((cell, cellIndex) => (
                  <td
                    key={`cell:${rowIndex}:${cellIndex}`}
                    className="border-b border-r border-border/30 px-3 py-2.5 align-top text-foreground/90 last:border-r-0"
                  >
                    <span className="break-words leading-6">{cell}</span>
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
});
