import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { annotateMarkdownSource, isMarkdownBodySelection } from '@/lib/wiki-selection';
import { handleMarkdownCodeBlockCopy } from '@/plugins/message-rendering/markdown-code-blocks';
import { getOrBuildMarkdownBody } from '@/plugins/message-rendering/md-pipeline';
import { useMarkdownExtensions } from '@/plugins/message-rendering/use-renderers';

type MarkdownImageResolver = (src: string, filePath: string) => Promise<string | null> | string | null;

interface MarkdownPreviewProps {
  filePath: string;
  markdown: string;
  resolveImageSrc?: MarkdownImageResolver;
  sourceMapping?: boolean;
  onTextSelection?(selection: Selection | null, root: HTMLDivElement): void;
}

const EMPTY_IMAGE_MAP = new Map<string, string>();

function imageSources(markdown: string): readonly string[] {
  const sources = new Set<string>();
  for (const match of markdown.matchAll(/!\[[^\]]*\]\(([^)\s]+)(?:\s+[^)]*)?\)/g)) {
    sources.add(match[1]);
  }
  return [...sources];
}

function rewriteImageSources(markdown: string, resolved: ReadonlyMap<string, string>): string {
  return markdown.replace(/(!\[[^\]]*\]\()([^\s)]+)((?:\s+[^)]*)?\))/g, (match, prefix: string, source: string, suffix: string) => {
    const target = resolved.get(source);
    return target ? `${prefix}${target}${suffix}` : match;
  });
}

function useResolvedMarkdownImages(filePath: string, markdown: string, resolveImageSrc: MarkdownImageResolver | undefined): string {
  const sources = useMemo(() => imageSources(markdown), [markdown]);
  const sourceKey = sources.join('\n');
  const [resolved, setResolved] = useState<Readonly<{ key: string; images: ReadonlyMap<string, string> }>>({ key: '', images: EMPTY_IMAGE_MAP });

  useEffect(() => {
    let cancelled = false;
    if (!resolveImageSrc || sources.length === 0) return () => { cancelled = true; };

    const key = `${filePath}\n${sourceKey}`;
    void Promise.all(sources.map(async (source) => {
      const target = await resolveImageSrc(source, filePath);
      return target ? [source, target] as const : null;
    })).then((entries) => {
      if (cancelled) return;
      const images = new Map<string, string>();
      for (const entry of entries) {
        if (entry) images.set(entry[0], entry[1]);
      }
      setResolved({ key, images });
    });

    return () => { cancelled = true; };
  }, [filePath, resolveImageSrc, sourceKey, sources]);

  if (!resolveImageSrc || sources.length === 0) return markdown;
  const key = `${filePath}\n${sourceKey}`;
  return rewriteImageSources(markdown, resolved.key === key ? resolved.images : EMPTY_IMAGE_MAP);
}

export const MarkdownPreview = memo(function MarkdownPreview({
  filePath,
  markdown,
  resolveImageSrc,
  sourceMapping = false,
  onTextSelection,
}: MarkdownPreviewProps) {
  const bodyRef = useRef<HTMLDivElement>(null);
  const extensions = useMarkdownExtensions();
  const resolvedMarkdown = useResolvedMarkdownImages(filePath, markdown, resolveImageSrc);
  const previewHtml = useMemo(() => {
    return getOrBuildMarkdownBody(`artifact-markdown:${filePath}:${resolvedMarkdown}`, {
      markdown: resolvedMarkdown,
    }, extensions).fullHtml;
  }, [extensions, filePath, resolvedMarkdown]);
  const mappedHtml = useMemo(() => {
    if (!sourceMapping) return previewHtml;
    const body = document.createElement('div');
    body.innerHTML = previewHtml;
    annotateMarkdownSource(body, markdown);
    return body.innerHTML;
  }, [markdown, previewHtml, sourceMapping]);
  const html = useMemo(() => ({ __html: mappedHtml }), [mappedHtml]);
  const captureSelection = useCallback(() => {
    const root = bodyRef.current;
    if (!root || !onTextSelection) return;
    const selection = window.getSelection();
    onTextSelection(selection && isMarkdownBodySelection(selection, root) ? selection : null, root);
  }, [onTextSelection]);
  const handlePreviewClick = useCallback((event: React.MouseEvent<HTMLDivElement>) => {
    handleMarkdownCodeBlockCopy(event);
  }, []);

  return (
    <div className="h-full min-h-0 overflow-auto p-4">
      <div
        ref={bodyRef}
        className="chat-markdown max-w-none break-words"
        tabIndex={onTextSelection ? 0 : undefined}
        onClick={handlePreviewClick}
        onMouseUp={onTextSelection ? captureSelection : undefined}
        onKeyUp={onTextSelection ? captureSelection : undefined}
        dangerouslySetInnerHTML={html}
      />
    </div>
  );
});
