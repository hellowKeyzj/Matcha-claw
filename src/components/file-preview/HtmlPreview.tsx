import { useTranslation } from 'react-i18next';
import { cn } from '@/lib/utils';

export interface HtmlPreviewProps {
  source: string;
  fileName?: string;
  className?: string;
}

export function HtmlPreview({ source, fileName, className }: HtmlPreviewProps) {
  const { t } = useTranslation('chat');

  return (
    <div className={cn('h-full min-h-0 bg-white', className)}>
      <iframe
        data-testid="html-preview-frame"
        title={fileName ?? t('filePreview.html.title', 'HTML preview')}
        srcDoc={source}
        sandbox="allow-scripts allow-forms"
        className="h-full w-full border-0 bg-white"
      />
    </div>
  );
}
