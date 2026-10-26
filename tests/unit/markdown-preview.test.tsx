import { act, render, screen } from '@testing-library/react';
import { Suspense, type ReactNode } from 'react';
import { describe, expect, it } from 'vitest';
import { MarkdownPreview } from '@/plugins/files/MarkdownPreview';
import { createPluginHost } from '@/plugin-host/core';
import { PluginHostProvider } from '@/plugin-host/react';
import { applicationShellPlugin } from '@/app/extensions';
import { messageRenderingPlugin } from '@/plugins/message-rendering/plugin';

const pluginHost = createPluginHost([applicationShellPlugin, messageRenderingPlugin]);

function MessagePlugins({ children }: { children: ReactNode }) {
  return <PluginHostProvider host={pluginHost}><Suspense fallback={null}>{children}</Suspense></PluginHostProvider>;
}

describe('MarkdownPreview', () => {
  it('soft-wraps fenced code blocks in rendered markdown previews', async () => {
    const longLine = 'config change requires channel reload (wecom) — deferring until 2 operation(s), 1 reply(ies), 1 embedded run(s) complete';

    await act(async () => {
      render(
        <MarkdownPreview
          filePath="/workspace/demo.md"
          markdown={['Gateway log:', '', '```', longLine, '```'].join('\n')}
        />,
        { wrapper: MessagePlugins },
      );
    });

    const preview = (await screen.findByText('Gateway log:')).parentElement;
    expect(preview?.querySelector('[data-chat-code-block]')).toHaveClass('chat-code-block');
    expect(preview?.querySelector('[data-chat-code-copy]')).toHaveClass('chat-code-copy');
    expect(preview?.querySelector('pre code')).toHaveTextContent(longLine);
  });
});
