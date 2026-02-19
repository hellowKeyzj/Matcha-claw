import { useEffect, useMemo, useState } from 'react';
import { SUBAGENT_TARGET_FILES } from '@/constants/subagent-files';
import type { PreviewDiffByFile, SubagentTargetFile } from '@/types/subagent';
import { useTranslation } from 'react-i18next';

interface SubagentDiffPreviewProps {
  previewDiffByFile: PreviewDiffByFile;
  persistedContentByFile?: Partial<Record<SubagentTargetFile, string>>;
}

const LINE_STYLE: Record<'keep' | 'add' | 'remove', string> = {
  keep: 'text-muted-foreground',
  add: 'text-green-600 dark:text-green-400',
  remove: 'text-red-600 dark:text-red-400',
};

const PREFIX: Record<'keep' | 'add' | 'remove', string> = {
  keep: ' ',
  add: '+',
  remove: '-',
};

export function SubagentDiffPreview({ previewDiffByFile, persistedContentByFile }: SubagentDiffPreviewProps) {
  const { t } = useTranslation('subagents');
  const entries = useMemo(
    () => Object.entries(previewDiffByFile).filter(([, lines]) => Array.isArray(lines) && lines.length > 0),
    [previewDiffByFile],
  );
  const persistedEntries = useMemo(
    () => SUBAGENT_TARGET_FILES.map((name) => [name, persistedContentByFile?.[name] ?? ''] as const),
    [persistedContentByFile],
  );
  const hasDiffPreview = entries.length > 0;
  const [selectedFileName, setSelectedFileName] = useState<string | null>(null);

  useEffect(() => {
    const availableNames = hasDiffPreview
      ? entries.map(([name]) => name)
      : persistedEntries.map(([name]) => name);
    if (availableNames.length === 0) {
      setSelectedFileName(null);
      return;
    }
    if (!selectedFileName || !availableNames.includes(selectedFileName)) {
      setSelectedFileName(availableNames[0]);
    }
  }, [entries, persistedEntries, hasDiffPreview, selectedFileName]);

  if (!hasDiffPreview && persistedEntries.length === 0) {
    return null;
  }

  const activeName = selectedFileName ?? (hasDiffPreview ? entries[0]?.[0] : persistedEntries[0]?.[0]) ?? null;
  if (!activeName) {
    return null;
  }
  const activeDiffEntry = entries.find(([name]) => name === activeName);
  const activeLines = activeDiffEntry?.[1] ?? [];
  const activePersistedEntry = persistedEntries.find(([name]) => name === activeName);
  const activeContent = activePersistedEntry?.[1] ?? '';
  const fileListEntries = hasDiffPreview ? entries.map(([name]) => name) : persistedEntries.map(([name]) => name);

  return (
    <section className="space-y-3">
      <h3 className="text-base font-semibold">
        {hasDiffPreview ? t('manage.diffPreviewTitle') : t('manage.currentFilesTitle')}
      </h3>
      <div className="grid gap-3 md:grid-cols-[200px_minmax(0,1fr)]">
        <aside className="space-y-2">
          {fileListEntries.map((name) => {
            const selected = name === activeName;
            return (
              <button
                key={name}
                type="button"
                className={`w-full rounded-md border px-3 py-2 text-left text-sm transition-colors ${
                  selected
                    ? 'border-primary bg-primary/10 text-primary'
                    : 'border-border bg-card hover:bg-accent'
                }`}
                aria-pressed={selected}
                onClick={() => setSelectedFileName(name)}
              >
                {name}
              </button>
            );
          })}
        </aside>
        <article className="rounded-lg border bg-card p-3">
          <h4 className="mb-2 text-sm font-medium">{activeName}</h4>
          {hasDiffPreview ? (
            <pre className="max-h-[460px] overflow-auto text-xs">
              {activeLines.map((line, index) => (
                <div key={`${activeName}-${index}`} className={LINE_STYLE[line.type]}>
                  {PREFIX[line.type]}
                  {line.value}
                </div>
              ))}
            </pre>
          ) : (
            <pre className="max-h-[460px] overflow-auto whitespace-pre-wrap text-xs text-foreground">
              {activeContent || t('manage.emptyFileContent')}
            </pre>
          )}
        </article>
      </div>
    </section>
  );
}

export default SubagentDiffPreview;
