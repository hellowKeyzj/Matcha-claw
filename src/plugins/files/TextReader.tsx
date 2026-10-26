import { StableScrollArea } from '@/components/scroll';
import { buildLineDiff } from '@/lib/line-diff';
import { cn } from '@/lib/utils';
import type { SnapshotFileReaderProps, TextFileReaderProps } from './extensions';

export function TextReader({ text }: TextFileReaderProps) {
  return (
    <StableScrollArea className="h-full min-h-0 overflow-auto p-3">
      <div className="overflow-hidden rounded-[18px] border border-border/45 bg-background shadow-sm">
        <pre className="overflow-auto px-4 py-3 text-[12px] leading-6 text-foreground/90">{text}</pre>
      </div>
    </StableScrollArea>
  );
}

export function PlainDiffReader({ file }: SnapshotFileReaderProps) {
  const diffRows = buildLineDiff(file.baseline ?? '', file.content ?? '');
  return (
    <StableScrollArea className="h-full min-h-0 overflow-auto p-3">
      <div className="overflow-auto rounded-[18px] border border-border/45 bg-background p-3 shadow-sm">
        <pre className="text-[12px] leading-6 text-foreground/90">
          {diffRows.map((row, index) => (
            <div
              key={`${row.type}:${index}`}
              className={cn(
                row.type === 'add' && 'bg-emerald-500/10 text-emerald-700 dark:text-emerald-300',
                row.type === 'remove' && 'bg-destructive/10 text-destructive',
              )}
            >
              <span className="mr-2 inline-block w-4 text-center">
                {row.type === 'add' ? '+' : row.type === 'remove' ? '-' : ' '}
              </span>
              {row.value}
            </div>
          ))}
        </pre>
      </div>
    </StableScrollArea>
  );
}
