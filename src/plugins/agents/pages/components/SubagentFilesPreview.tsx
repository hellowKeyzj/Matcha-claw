import { useState } from 'react';
import { SUBAGENT_TARGET_FILES } from '@/constants/subagent-files';
import type { SubagentTargetFile } from '@/types/subagent';
import { useTranslation } from 'react-i18next';

interface SubagentFilesPreviewProps {
  persistedContentByFile?: Partial<Record<SubagentTargetFile, string>>;
}

export function SubagentFilesPreview({ persistedContentByFile }: SubagentFilesPreviewProps) {
  const { t } = useTranslation('subagents');
  const [selectedFileName, setSelectedFileName] = useState<SubagentTargetFile>(SUBAGENT_TARGET_FILES[0]);
  const activeContent = persistedContentByFile?.[selectedFileName] ?? '';

  return (
    <section className="space-y-3">
      <h3 className="text-base font-semibold">{t('manage.currentFilesTitle')}</h3>
      <div className="grid gap-3 md:grid-cols-[200px_minmax(0,1fr)]">
        <aside className="space-y-2">
          {SUBAGENT_TARGET_FILES.map((name) => {
            const selected = name === selectedFileName;
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
          <h4 className="mb-2 text-sm font-medium">{selectedFileName}</h4>
          <pre className="h-[460px] overflow-auto whitespace-pre-wrap text-xs text-foreground">
            {activeContent || t('manage.emptyFileContent')}
          </pre>
        </article>
      </div>
    </section>
  );
}

export default SubagentFilesPreview;
