import { StableScrollArea } from '@/components/scroll';
import { CsvPreview } from '@/plugins/chat/components/CsvPreview';
import type { TextFileReaderProps } from './extensions';

export function CsvReader({ text }: TextFileReaderProps) {
  return (
    <StableScrollArea className="h-full min-h-0 overflow-auto p-3">
      <CsvPreview csv={text} />
    </StableScrollArea>
  );
}
