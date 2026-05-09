import { lazy, memo, Suspense } from 'react';
import { LoadingSpinner } from '@/components/common/LoadingSpinner';
import { cn } from '@/lib/utils';

interface MonacoViewerProps {
  filePath: string;
  value: string;
  className?: string;
}

const MonacoViewerInner = lazy(async () => {
  const [{ Editor, languageForPath }, { useSettingsStore }, { useResolvedTheme }] = await Promise.all([
    import('@/lib/monaco/loader'),
    import('@/stores/settings'),
    import('@/lib/use-resolved-theme'),
  ]);

  function Component({
    filePath,
    value,
    className,
  }: MonacoViewerProps) {
    const theme = useSettingsStore((state) => state.theme);
    const resolvedTheme = useResolvedTheme(theme);
    const isDark = resolvedTheme === 'dark';

    return (
      <div
        data-testid="monaco-viewer"
        className={cn('h-full min-h-0 w-full overflow-hidden', className)}
      >
        <Editor
          height="100%"
          language={languageForPath(filePath)}
          value={value}
          theme={isDark ? 'vs-dark' : 'vs'}
          options={{
            readOnly: true,
            minimap: { enabled: false },
            scrollBeyondLastLine: false,
            wordWrap: 'on',
            lineNumbers: 'on',
            glyphMargin: false,
            folding: true,
            renderLineHighlight: 'none',
            overviewRulerBorder: false,
            automaticLayout: true,
          }}
        />
      </div>
    );
  }

  return { default: Component };
});

export const MonacoViewer = memo(function MonacoViewer(props: MonacoViewerProps) {
  return (
    <Suspense
      fallback={(
        <div className="flex h-full items-center justify-center">
          <LoadingSpinner />
        </div>
      )}
    >
      <MonacoViewerInner {...props} />
    </Suspense>
  );
});
