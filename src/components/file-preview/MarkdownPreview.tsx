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
        className="chat-markdown max-w-none break-words"
        dangerouslySetInnerHTML={{ __html: previewHtml }}
      />
    </div>
  );
}
