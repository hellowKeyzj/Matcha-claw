import { useMemo } from 'react';
import { getOrBuildMarkdownBody } from '@/pages/Chat/md-pipeline';

interface MarkdownPreviewProps {
  filePath: string;
  markdown: string;
}

export function MarkdownPreview({
  filePath,
  markdown,
}: MarkdownPreviewProps) {
  const previewHtml = useMemo(() => {
    return getOrBuildMarkdownBody(`artifact-markdown:${filePath}:${markdown}`, {
      markdown,
    }).fullHtml;
  }, [filePath, markdown]);

  return (
    <div className="h-full min-h-0 overflow-auto p-4">
      <div
        className="prose prose-zinc max-w-none break-words dark:prose-invert prose-headings:mb-2 prose-headings:mt-4 prose-p:my-2 prose-pre:rounded-[18px] prose-pre:border prose-pre:border-border/45 prose-pre:bg-background/88 prose-pre:px-4 prose-pre:py-3 prose-code:rounded prose-code:bg-background/75 prose-code:px-1 prose-code:py-0.5"
        dangerouslySetInnerHTML={{ __html: previewHtml }}
      />
    </div>
  );
}
