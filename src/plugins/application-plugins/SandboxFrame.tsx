import { useEffect, useMemo, useRef, useState } from 'react';
import { buildSandboxDocument } from './sandbox-document';

interface SandboxFrameProps {
  html: string;
  title: string;
  input: unknown;
  onReady?: () => void;
  onError?: (message: string) => void;
}

/** Trusted adapter only: package code executes in the proxy's opaque inner iframe. */
export function SandboxFrame({ html, title, input, onReady, onError }: SandboxFrameProps) {
  const container = useRef<HTMLDivElement>(null);
  const callbacks = useRef({ onReady, onError });
  const identity = useMemo(() => ({ html, input, title }), [html, input, title]);
  const [result, setResult] = useState<{ identity: typeof identity; error?: string } | null>(null);
  const error = result?.identity === identity ? result.error : undefined;
  const status = result?.identity !== identity ? 'loading' : error ? 'error' : 'ready';

  useEffect(() => { callbacks.current = { onReady, onError }; }, [onReady, onError]);

  useEffect(() => {
    const root = container.current;
    if (!root) return;
    const frame = document.createElement('iframe');
    frame.title = identity.title;
    frame.setAttribute('sandbox', 'allow-scripts');
    frame.referrerPolicy = 'no-referrer';
    frame.className = 'h-full w-full border-0';
    const channel = new MessageChannel();
    let loaded = false;
    let ready = false;
    let closed = false;
    let timer: ReturnType<typeof setTimeout>;
    const dispose = () => {
      if (closed) return;
      closed = true;
      clearTimeout(timer);
      frame.removeEventListener('load', load);
      frame.removeEventListener('error', loadError);
      channel.port1.onmessage = null;
      channel.port1.onmessageerror = null;
      channel.port1.close();
      channel.port2.close();
      frame.remove();
    };
    const fail = (message: string) => {
      if (closed) return;
      dispose();
      setResult({ identity, error: message });
      callbacks.current.onError?.(message);
    };
    const load = () => {
      if (closed) return;
      if (loaded) { fail('插件沙箱发生了导航'); return; }
      loaded = true;
      const target = frame.contentWindow;
      if (!target) { fail('插件沙箱不可用'); return; }
      try {
        // The fixed opaque target requires '*'; the transferred port is the only app channel.
        target.postMessage({ type: 'matcha:reader-connect' }, '*', [channel.port2]);
        channel.port1.postMessage({ type: 'render', input: identity.input });
      } catch { fail('插件输入无法发送到沙箱'); }
    };
    const loadError = () => fail('插件沙箱加载失败');
    channel.port1.onmessage = (event: MessageEvent<unknown>) => {
      event.ports.forEach(port => port.close());
      if (closed) return;
      const data = event.data;
      if (event.ports.length || typeof data !== 'object' || data === null || Array.isArray(data)) {
        fail('无效的插件回执');
        return;
      }
      const receipt = data as Record<string, unknown>;
      if (receipt.type === 'ready') {
        if (ready) return;
        ready = true;
        clearTimeout(timer);
        setResult({ identity });
        // Ready is the plugin's claim, not proof that its output is correct.
        callbacks.current.onReady?.();
      } else if (receipt.type === 'error' && typeof receipt.message === 'string') {
        fail(receipt.message.slice(0, 500) || '插件执行失败');
      } else {
        fail('不支持的插件请求');
      }
    };
    channel.port1.onmessageerror = () => fail('插件回执无法解码');
    channel.port1.start();
    timer = setTimeout(() => fail('插件未在 10 秒内就绪'), 10_000);
    frame.addEventListener('load', load);
    frame.addEventListener('error', loadError);
    frame.srcdoc = buildSandboxDocument(identity.html);
    root.appendChild(frame);
    // Replacing HTML/input tears down the browsing context; no old document receives a new file.
    return dispose;
  }, [identity]);

  return (
    <div className="relative h-full min-h-0 w-full" aria-busy={status === 'loading'}>
      <div ref={container} className="h-full w-full" style={{ visibility: status === 'ready' ? 'visible' : 'hidden' }} />
      {status === 'loading' && (
        <div role="status" className="absolute inset-0 flex items-center justify-center text-sm text-muted-foreground">插件加载中…</div>
      )}
      {status === 'error' && (
        <div role="alert" className="absolute inset-0 flex items-center justify-center p-4 text-sm text-destructive">{error}</div>
      )}
    </div>
  );
}
