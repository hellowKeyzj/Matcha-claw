import { lazy, memo, Suspense } from 'react';
import { LoadingSpinner } from '@/components/common/LoadingSpinner';
import { cn } from '@/lib/utils';

interface MonacoDiffViewerProps {
  filePath: string;
  original: string;
  modified: string;
  className?: string;
}

const MonacoDiffViewerInner = lazy(async () => {
  const [{ DiffEditor, languageForPath }, { useSettingsStore }, { useResolvedTheme }] = await Promise.all([
    import('@/lib/monaco/loader'),
    import('@/stores/settings'),
    import('@/lib/use-resolved-theme'),
  ]);

  function Component({
    filePath,
    original,
    modified,
    className,
  }: MonacoDiffViewerProps) {
    const theme = useSettingsStore((state) => state.theme);
    const resolvedTheme = useResolvedTheme(theme);
    const isDark = resolvedTheme === 'dark';

    return (
      <div
        data-testid="monaco-diff-viewer"
        className={cn('clawx-diff-editor h-full min-h-0 w-full overflow-hidden', className)}
      >
        <DiffEditor
          height="100%"
          language={languageForPath(filePath)}
          original={original}
          modified={modified}
          theme={isDark ? 'vs-dark' : 'vs'}
          options={{
            readOnly: true,
            minimap: { enabled: false },
            scrollBeyondLastLine: false,
            wordWrap: 'on',
            renderSideBySide: false,
            renderOverviewRuler: false,
            automaticLayout: true,
          }}
        />
      </div>
    );
  }

  return { default: Component };
});

export const MonacoDiffViewer = memo(function MonacoDiffViewer(props: MonacoDiffViewerProps) {
  return (
    <Suspense
      fallback={(
        <div className="flex h-full items-center justify-center">
          <LoadingSpinner />
        </div>
      )}
    >
      <MonacoDiffViewerInner {...props} />
    </Suspense>
  );
});
