import { useCallback, useEffect } from 'react';
import { createPortal } from 'react-dom';
import { FolderOpen, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { invokeIpc } from '@/lib/api-client';

interface ChatImageLightboxProps {
  src: string;
  fileName: string;
  filePath?: string;
  onClose: () => void;
}

export function ChatImageLightbox({
  src,
  fileName,
  filePath,
  onClose,
}: ChatImageLightboxProps) {
  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        onClose();
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [onClose]);

  const handleShowInFolder = useCallback(() => {
    if (!filePath) {
      return;
    }
    void invokeIpc('shell:showItemInFolder', filePath);
  }, [filePath]);

  return createPortal(
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/76 backdrop-blur-md"
      onClick={onClose}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label={fileName}
        className="flex max-w-[92vw] flex-col items-center gap-4"
        onClick={(event) => event.stopPropagation()}
      >
        <img
          src={src}
          alt={fileName}
          className="max-h-[84vh] max-w-[92vw] rounded-[20px] object-contain shadow-2xl"
        />
        <div className="inline-flex items-center gap-2 rounded-full border border-white/12 bg-black/28 px-2 py-2 text-white shadow-lg backdrop-blur-xl">
          {filePath && (
            <Button
              variant="ghost"
              size="icon"
              className="h-8 w-8 rounded-full bg-white/10 text-white hover:bg-white/18"
              onClick={handleShowInFolder}
              title="在文件夹中显示"
            >
              <FolderOpen className="h-4 w-4" />
            </Button>
          )}
          <Button
            variant="ghost"
            size="icon"
            className="h-8 w-8 rounded-full bg-white/10 text-white hover:bg-white/18"
            onClick={onClose}
            title="关闭"
          >
            <X className="h-4 w-4" />
          </Button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
