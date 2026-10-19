// Native independent-origin proxy; untrusted documents remain in its opaque inner frame.
export type SandboxMessage = (data: unknown, ports: readonly MessagePort[]) => void;

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export class SandboxChannel {
  private readonly listeners = new Set<SandboxMessage>();
  private readonly closeListeners = new Set<() => void>();
  private readonly url: URL;
  private readonly nonce: string | null;
  private port: MessagePort | null = null;
  private loaded = false;
  private ready = false;
  private closed = false;
  private settleReady: (() => void) | null = null;
  private rejectReady: ((error: Error) => void) | null = null;
  private readyTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(readonly frame: HTMLIFrameElement, sandboxUrl: string) {
    this.url = new URL(sandboxUrl);
    if (!['http:', 'https:'].includes(this.url.protocol) || this.url.username || this.url.password
      || this.url.hash || this.url.pathname !== '/mcp-app-sandbox'
      || [...this.url.searchParams.keys()].some((key) => key !== 'csp')
      || this.url.origin === window.location.origin) throw new Error('Invalid isolated sandbox');
    this.nonce = window.location.protocol === 'file:'
      ? Array.from(crypto.getRandomValues(new Uint8Array(32)), (byte) => byte.toString(16).padStart(2, '0')).join('')
      : null;
    if (this.nonce) {
      this.url.searchParams.set('matcha_parent', 'file');
      this.url.hash = `matcha-sandbox=${this.nonce}`;
    }
  }

  start(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.settleReady = resolve;
      this.rejectReady = reject;
      this.readyTimer = setTimeout(() => this.close(new Error('Sandbox connection timed out')), 15_000);
      window.addEventListener('message', this.onWindowMessage);
      this.frame.addEventListener('load', this.onLoad);
      this.frame.setAttribute('sandbox', 'allow-scripts allow-same-origin allow-forms');
      this.frame.referrerPolicy = 'origin';
      this.frame.src = this.url.href;
    });
  }

  subscribe(listener: SandboxMessage): () => void {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }

  onClose(listener: () => void): () => void {
    this.closeListeners.add(listener);
    return () => { this.closeListeners.delete(listener); };
  }

  post(data: unknown): void {
    if (this.closed || !this.ready) throw new Error('Sandbox is unavailable');
    if (this.nonce) this.port?.postMessage(data);
    else this.frame.contentWindow?.postMessage(data, this.url.origin);
  }

  load(html: string, options: { strict?: boolean; csp?: unknown } = {}): Promise<void> {
    const renderId = crypto.randomUUID();
    return new Promise((resolve, reject) => {
      const cleanup = () => { clearTimeout(timer); offMessage(); offClose(); };
      const fail = () => { cleanup(); reject(new Error('Sandbox content is unavailable')); };
      const offClose = this.onClose(fail);
      const offMessage = this.subscribe((data) => {
        if (!isRecord(data) || data.method !== 'ui/notifications/sandbox-resource-loaded'
          || !isRecord(data.params) || data.params.renderId !== renderId) return;
        cleanup();
        resolve();
      });
      const timer = setTimeout(fail, 10_000);
      try {
        this.post({ jsonrpc: '2.0', method: 'ui/notifications/sandbox-resource-ready', params: {
          html, renderId, ...(options.csp ? { csp: options.csp } : {}), ...(options.strict ? { sandbox: 'strict' } : {}),
        } });
      } catch { fail(); }
    });
  }

  private readonly onLoad = () => {
    if (this.closed) return;
    if (this.loaded) { this.close(new Error('Sandbox navigated')); return; }
    this.loaded = true;
    if (!this.nonce) return;
    const target = this.frame.contentWindow;
    if (!target) { this.close(); return; }
    const channel = new MessageChannel();
    this.port = channel.port1;
    channel.port1.onmessage = (event) => this.receive(event.data, event.ports);
    channel.port1.onmessageerror = () => this.close(new Error('Invalid sandbox channel'));
    channel.port1.start();
    try {
      target.postMessage({ type: 'matcha:sandbox-connect', nonce: this.nonce }, this.url.origin, [channel.port2]);
    } catch {
      channel.port2.close();
      this.close(new Error('Sandbox connection failed'));
    }
  };

  private readonly onWindowMessage = (event: MessageEvent<unknown>) => {
    // File parents never accept protocol traffic on the ambient null-origin window channel.
    if (this.nonce || event.source !== this.frame.contentWindow || event.origin !== this.url.origin) return;
    this.receive(event.data, event.ports);
  };

  private receive(data: unknown, ports: readonly MessagePort[]) {
    if (this.closed) { ports.forEach((port) => port.close()); return; }
    if (isRecord(data) && data.method === 'ui/notifications/sandbox-proxy-ready') {
      if (this.ready || !isRecord(data.params) || data.params.sandboxUrl !== this.url.href || ports.length) {
        ports.forEach((port) => port.close());
        this.close(new Error('Invalid sandbox handshake'));
        return;
      }
      this.ready = true;
      if (this.readyTimer) clearTimeout(this.readyTimer);
      this.settleReady?.();
      this.settleReady = null;
      this.rejectReady = null;
      return;
    }
    if (!this.ready) { ports.forEach((port) => port.close()); return; }
    if (ports.length && (!isRecord(data)
      || !['openclaw:widget-bridge-port-offer', 'openclaw:widget-prompt-offer'].includes(String(data.type)))) {
      ports.forEach((port) => port.close());
      return;
    }
    if (!this.listeners.size) ports.forEach((port) => port.close());
    for (const listener of this.listeners) listener(data, ports);
  }

  close(error = new Error('Sandbox closed')): void {
    if (this.closed) return;
    this.closed = true;
    this.ready = false;
    if (this.readyTimer) clearTimeout(this.readyTimer);
    this.rejectReady?.(error);
    this.rejectReady = null;
    this.settleReady = null;
    window.removeEventListener('message', this.onWindowMessage);
    this.frame.removeEventListener('load', this.onLoad);
    this.port?.close();
    this.port = null;
    for (const listener of this.closeListeners) listener();
    this.closeListeners.clear();
    this.listeners.clear();
    this.frame.src = 'about:blank';
  }
}
