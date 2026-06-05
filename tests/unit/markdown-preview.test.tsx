import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { MarkdownPreview } from '@/components/file-preview/MarkdownPreview';

describe('MarkdownPreview', () => {
  it('soft-wraps fenced code blocks in rendered markdown previews', () => {
    const longLine = 'config change requires channel reload (wecom) — deferring until 2 operation(s), 1 reply(ies), 1 embedded run(s) complete';

    render(
      <MarkdownPreview
        filePath="/workspace/demo.md"
        markdown={['Gateway log:', '', '```', longLine, '```'].join('\n')}
      />,
    );

    const preview = screen.getByText('Gateway log:').parentElement;
    expect(preview).toHaveClass('prose-pre:whitespace-pre-wrap');
    expect(preview).toHaveClass('prose-pre:break-words');
    expect(preview?.querySelector('pre')).toHaveTextContent(longLine);
  });
});
