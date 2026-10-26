const POLICY = "default-src 'none'; connect-src 'none'; form-action 'none'; base-uri 'none'; frame-src 'none'; object-src 'none'; worker-src 'none'; img-src data: blob:; style-src 'unsafe-inline'; script-src 'unsafe-inline'";

const INNER_BOOTSTRAP = `(() => {
  // Same-realm egress reduction, not an OS sandbox or a complete WebRTC firewall.
  for (const name of ['RTCPeerConnection', 'webkitRTCPeerConnection', 'RTCIceGatherer', 'RTCIceTransport', 'RTCDtlsTransport', 'RTCSctpTransport', 'RTCDataChannel', 'Worker', 'SharedWorker', 'ServiceWorker', 'ServiceWorkerContainer', 'ServiceWorkerRegistration']) {
    Object.defineProperty(window, name, { value: undefined, writable: false, configurable: false });
  }
  Object.defineProperty(navigator, 'serviceWorker', { value: undefined, writable: false, configurable: false });
  let port = null;
  let hasInput = false;
  let input;
  let status = null;
  let sentStatus = null;
  const callbacks = new Set();
  const sendStatus = () => {
    if (!port || !hasInput || !status || sentStatus === status) return;
    port.postMessage(status);
    sentStatus = status;
  };
  const error = message => {
    if (status?.type === 'error') return;
    status = { type: 'error', message: typeof message === 'string' && message ? message.slice(0, 500) : '插件执行失败' };
    sendStatus();
  };
  const deliver = callback => {
    try { callback(input); }
    catch (cause) { error(cause instanceof Error ? cause.message : '插件渲染失败'); }
  };
  Object.defineProperty(window, 'matchaReader', {
    value: Object.freeze({
      onInput(callback) {
        if (typeof callback !== 'function') throw new TypeError('onInput requires a callback');
        callbacks.add(callback);
        if (hasInput) deliver(callback);
        return () => { callbacks.delete(callback); };
      },
      ready() {
        if (status) return;
        status = { type: 'ready' };
        sendStatus();
      },
      error,
    }),
    writable: false,
    configurable: false,
  });
  const connect = event => {
    if (event.source !== window.parent || event.data?.type !== 'matcha:reader-connect') return;
    event.stopImmediatePropagation();
    window.removeEventListener('message', connect, true);
    if (event.ports.length !== 1) { event.ports.forEach(value => value.close()); return; }
    port = event.ports[0];
    port.onmessage = event => {
      event.ports.forEach(value => value.close());
      if (event.ports.length || hasInput || event.data?.type !== 'render') { error('无效的插件输入通道'); return; }
      hasInput = true;
      input = event.data.input;
      callbacks.forEach(deliver);
      sendStatus();
    };
    port.onmessageerror = () => error('插件输入无法解码');
    port.start();
  };
  const scriptError = event => error(event.message || '插件脚本执行失败');
  const rejection = event => error(event.reason instanceof Error ? event.reason.message : '插件异步执行失败');
  const dispose = () => {
    window.removeEventListener('message', connect, true);
    window.removeEventListener('error', scriptError);
    window.removeEventListener('unhandledrejection', rejection);
    window.removeEventListener('pagehide', dispose);
    callbacks.clear();
    input = undefined;
    if (port) { port.onmessage = null; port.onmessageerror = null; port.close(); port = null; }
  };
  window.addEventListener('message', connect, true);
  window.addEventListener('error', scriptError);
  window.addEventListener('unhandledrejection', rejection);
  window.addEventListener('pagehide', dispose);
})();`;

/** Package HTML is parsed only inside the opaque inner document, after its policy and bootstrap. */
export function buildSandboxDocument(html: string): string {
  const inner = `<!doctype html><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="${POLICY}"><script>${INNER_BOOTSTRAP}</script>${html}`;
  // Never interpolate package markup into the trusted outer parser or script.
  const serializedInner = JSON.stringify(inner).replaceAll('<', '\\u003c');
  return `<!doctype html>
<meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="${POLICY}">
<style>html,body{height:100%;margin:0}iframe{display:block;width:100%;height:100%;border:0}</style>
<body><script>(() => {
  const inner = document.createElement('iframe');
  inner.setAttribute('sandbox', 'allow-scripts');
  inner.referrerPolicy = 'no-referrer';
  inner.title = '插件内容';
  const channel = new MessageChannel();
  let transfer = channel.port2;
  let host = null;
  let loaded = false;
  let rendered = false;
  let disposed = false;
  const dispose = () => {
    if (disposed) return;
    disposed = true;
    window.removeEventListener('message', connect);
    window.removeEventListener('pagehide', dispose);
    inner.removeEventListener('load', onLoad);
    channel.port1.onmessage = null;
    channel.port1.onmessageerror = null;
    channel.port1.close();
    transfer?.close();
    transfer = null;
    if (host) { host.onmessage = null; host.onmessageerror = null; host.close(); host = null; }
    inner.remove();
  };
  const fail = message => {
    host?.postMessage({ type: 'error', message });
    dispose();
  };
  const offer = () => {
    if (!loaded || !host || !transfer || disposed) return;
    try {
      inner.contentWindow.postMessage({ type: 'matcha:reader-connect' }, '*', [transfer]);
      transfer = null;
    } catch { fail('无法连接插件内容'); }
  };
  const onLoad = () => {
    if (loaded) { fail('插件内容发生了导航'); return; }
    loaded = true;
    offer();
  };
  const connect = event => {
    if (event.source !== window.parent || event.data?.type !== 'matcha:reader-connect') return;
    window.removeEventListener('message', connect);
    if (event.ports.length !== 1) { event.ports.forEach(value => value.close()); dispose(); return; }
    host = event.ports[0];
    host.onmessage = event => {
      event.ports.forEach(value => value.close());
      if (event.ports.length || rendered || event.data?.type !== 'render') { fail('不支持的插件请求'); return; }
      rendered = true;
      channel.port1.postMessage({ type: 'render', input: event.data.input });
    };
    host.onmessageerror = () => fail('插件通道无法解码');
    host.start();
    offer();
  };
  // Only ready/error receipts cross the trusted proxy; no Host API or tool dispatch exists.
  channel.port1.onmessage = event => {
    event.ports.forEach(value => value.close());
    const data = event.data;
    if (event.ports.length) { fail('不支持的插件端口'); return; }
    if (data?.type === 'ready') host?.postMessage({ type: 'ready' });
    else if (data?.type === 'error' && typeof data.message === 'string') fail(data.message.slice(0, 500));
    else fail('不支持的插件请求');
  };
  channel.port1.onmessageerror = () => fail('插件回执无法解码');
  channel.port1.start();
  window.addEventListener('message', connect);
  window.addEventListener('pagehide', dispose);
  inner.addEventListener('load', onLoad);
  // srcdoc is a local document; the outer frame-src policy also governs inner replacement navigations.
  inner.srcdoc = ${serializedInner};
  document.body.appendChild(inner);
})();</script></body>`;
}
