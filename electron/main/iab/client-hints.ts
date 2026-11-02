import type { Session, WebContents, WebFrameMain } from 'electron';
import { iabClientHintHeaders, resolveIabUserAgentOverride } from './user-agent';

export type ReadClientHintsPolicy = (contents: WebContents, expression: string, signal: AbortSignal) => Promise<unknown>;
const HINTS = Object.keys(iabClientHintHeaders());
const LOW_ENTROPY = new Set(HINTS.slice(0, 3));
type Policy = Map<string, string[]>;
type Request = {
  added: Set<string>; sent: Set<string>; url: string; generation: number; mainOrigin: string | null;
  navigation?: { method: string; restartable: boolean };
};
type Document = { url: string; policy: Policy };
const invalidations = new WeakMap<Session, () => void>();

export function invalidateIabClientHints(session: Session): void {
  invalidations.get(session)?.();
}

function parseHints(value: string): Set<string> | null {
  const hints = new Set<string>();
  let rest = value.trim();
  const token = /^[A-Za-z*][!#$%&'*+\-.^_`|~\w:/]*/;
  const parameter = /^; *[a-z*][a-z0-9_.*-]*(?:=(?:"(?:[\x20-\x21\x23-\x5b\x5d-\x7e]|\\["\\])*"|\?[01]|-?\d{1,12}\.\d{1,3}|-?\d{1,15}|:[A-Za-z0-9+/=]*:|[A-Za-z*][!#$%&'*+\-.^_`|~\w:/]*))?/;
  while (rest) {
    const match = token.exec(rest);
    if (!match) return null;
    const hint = match[0].toLowerCase();
    if (HINTS.includes(hint)) hints.add(hint);
    rest = rest.slice(match[0].length);
    while (rest.startsWith(';')) {
      const match = parameter.exec(rest);
      if (!match) return null;
      rest = rest.slice(match[0].length);
    }
    rest = rest.trimStart();
    if (!rest) return hints;
    if (!rest.startsWith(',')) return null;
    rest = rest.slice(1).trimStart();
    if (!rest) return null;
  }
  return hints;
}

function header(headers: Record<string, string[]> | undefined, name: string): string[] | undefined {
  const entries = Object.entries(headers ?? {}).filter(([key]) => key.toLowerCase() === name);
  return entries.length ? entries.flatMap(([, value]) => value) : undefined;
}
function httpsOrigin(value: string): string | null {
  try { const url = new URL(value); return url.protocol === 'https:' ? url.origin : null; } catch { return null; }
}
function trimMap<K, V>(map: Map<K, V>, limit: number): void {
  while (map.size > limit) map.delete(map.keys().next().value!);
}
function parsePolicy(headers: string[] | undefined): Policy {
  const policy: Policy = new Map();
  for (const part of headers?.join(',').split(',') ?? []) {
    const match = /^\s*(ch-ua(?:-[a-z0-9-]+)?)\s*=\s*(.*?)\s*$/.exec(part);
    if (!match || !HINTS.includes(`sec-${match[1]}`)) continue;
    const hint = `sec-${match[1]}`;
    if (policy.has(hint)) { policy.set(hint, []); continue; }
    if (match[2] === '*') { policy.set(hint, ['*']); continue; }
    const origins: string[] = [];
    let rest = /^\((.*)\)$/.exec(match[2])?.[1].trim() ?? 'invalid';
    while (rest) {
      const origin = /^(self|"https:\/\/[^"\s]+")(?=\s|$)/.exec(rest);
      if (!origin) { origins.length = 0; break; }
      origins.push(origin[1] === 'self' ? 'self' : origin[1].slice(1, -1));
      rest = rest.slice(origin[0].length).trimStart();
    }
    policy.set(hint, origins);
  }
  return policy;
}
function allowsHint(policy: Policy, hint: string, source: string, target: string): boolean {
  const origins = policy.get(hint);
  if (!origins) return LOW_ENTROPY.has(hint) || source === target;
  return origins.some((origin) => {
    if (origin === '*') return true;
    if (origin === 'self') return source === target;
    if (!origin.includes('*') && httpsOrigin(origin) === target) return true;
    const wildcard = /^https:\/\/\*\.([^/:]+)(:\d+)?$/.exec(origin);
    if (!wildcard) return false;
    const parsedTarget = new URL(target);
    const wildcardOrigin = httpsOrigin(`https://${wildcard[1]}${wildcard[2] ?? ''}`);
    if (!wildcardOrigin) return false;
    const parsedWildcard = new URL(wildcardOrigin);
    return parsedTarget.protocol === 'https:' && parsedTarget.port === parsedWildcard.port && parsedTarget.hostname.endsWith(`.${parsedWildcard.hostname}`);
  });
}
function hasJavaScript(contents: WebContents | null | undefined): contents is WebContents {
  try {
    const target = contents as (WebContents & { getLastWebPreferences?(): Electron.WebPreferences | null }) | null | undefined;
    if (!target || target.isDestroyed() || typeof target.getLastWebPreferences !== 'function') return false;
    const preferences = target.getLastWebPreferences();
    return !!preferences && preferences.javascript !== false;
  } catch { return false; }
}
const inheritsPolicy = (url: string) => !url || /^about:(?:blank|srcdoc)(?:[?#]|$)/.test(url) || url.startsWith('blob:');

/** Supplements native hints only after Chromium's document/iframe permissions policy permits them. */
export function installIabClientHints(session: Session, read: ReadClientHintsPolicy): () => void {
  const values = iabClientHintHeaders();
  const userAgent = resolveIabUserAgentOverride().userAgent;
  const accepted = new Map<string, Set<string>>();
  const documents = new Map<number, Document>();
  const requests = new Map<number, Request>();
  const queues = new WeakMap<WebContents, { active: boolean; waiting: Set<() => void> }>();
  const policyCache = new WeakMap<WebFrameMain, { token: string; url: string; origins: Map<string, Promise<Set<string>>> }>();
  const controllers = new Set<AbortController>();
  let generation = 0;
  let disposed = false;
  let criticalRetryTrackingComplete = true;
  const invalidate = () => { generation++; accepted.clear(); documents.clear(); };
  invalidations.set(session, invalidate);

  function readPolicy(contents: WebContents, frame: WebFrameMain, origin: string, child: boolean): Promise<Set<string>> {
    const queue = queues.get(contents) ?? { active: false, waiting: new Set<() => void>() };
    queues.set(contents, queue);
    if (disposed || queue.waiting.size >= 64) return Promise.resolve(new Set());
    return new Promise((resolve) => {
      let settled = false;
      const controller = new AbortController();
      controllers.add(controller);
      const finish = (hints: Set<string>) => {
        clearTimeout(timer);
        controllers.delete(controller);
        if (!settled) { settled = true; resolve(hints); }
        queue.active = false;
        advance();
      };
      const abort = () => {
        clearTimeout(timer);
        if (!settled) { settled = true; resolve(new Set()); }
        controllers.delete(controller);
        queue.waiting.delete(run);
      };
      controller.signal.addEventListener('abort', abort, { once: true });
      const timer = setTimeout(() => { controller.abort(); }, 200);
      timer.unref();
      const advance = () => {
        if (queue.active) return;
        const next = queue.waiting.values().next().value;
        if (next) { queue.waiting.delete(next); next(); }
      };
      const run = () => {
        queue.active = true;
        try {
          const token = frame.frameToken;
          const url = frame.url;
          const parent = frame.parent;
          if (child && !parent) return finish(new Set());
          const sameOrigin = child && frame.origin !== 'null' && frame.origin === parent?.origin;
          const subject = child && !sameOrigin ? parent! : frame;
          const subjectToken = subject.frameToken;
          const index = child && !sameOrigin ? subject.frames.findIndex((item) => item.frameTreeNodeId === frame.frameTreeNodeId) : -1;
          const isCurrent = () => !contents.isDestroyed() && !frame.isDestroyed() && !frame.detached && frame.frameToken === token && frame.url === url &&
            !subject.isDestroyed() && !subject.detached && subject.frameToken === subjectToken &&
            (!child || sameOrigin || subject.frames[index]?.frameTreeNodeId === frame.frameTreeNodeId);
          if (!isCurrent()) return finish(new Set());
          const policy = child
            ? sameOrigin ? 'window.frameElement?.featurePolicy' : `Array.from(document.querySelectorAll('iframe,frame')).find(element => element.contentWindow === window.frames[${index}])?.featurePolicy`
            : 'document.featurePolicy';
          const expression = `(() => { const policy = ${policy}; if (!policy || typeof policy.allowsFeature !== 'function') return []; const features = policy.features(); return ${JSON.stringify(HINTS)}.filter(hint => { const feature = hint.slice(4); return features.includes(feature) && policy.allowsFeature(feature, ${JSON.stringify(origin)}); }); })()`;
          const main = contents.mainFrame;
          const path: number[] = [];
          let ancestor = subject;
          while (ancestor && ancestor !== main && ancestor.origin === main.origin) {
            const parent = ancestor.parent;
            if (!parent) break;
            path.unshift(parent.frames.findIndex((item) => item.frameTreeNodeId === ancestor.frameTreeNodeId));
            ancestor = parent;
          }
          const script = path.length
            ? `(() => { let view = window; for (const index of ${JSON.stringify(path)}) view = view.frames[index]; return (function(window, document) { return ${expression}; })(view, view.document); })()` : expression;
          const result = ancestor === main && path.every((item) => item >= 0) ? read(contents, script, controller.signal) : Promise.resolve([]);
          result.then((value) => {
            try { finish(isCurrent() && Array.isArray(value) ? new Set(value.filter((hint): hint is string => typeof hint === 'string' && HINTS.includes(hint))) : new Set()); }
            catch { finish(new Set()); }
          }, () => finish(new Set()));
        } catch { finish(new Set()); }
      };
      queue.waiting.add(run);
      advance();
    });
  }

  async function permittedHints(details: Electron.OnBeforeSendHeadersListenerDetails, origin: string): Promise<Set<string>> {
    const frame = details.frame;
    const contents = details.webContents;
    if (!frame || !contents) return new Set();
    try {
      if (frame.isDestroyed() || frame.detached) return new Set();
      const top = frame.top ?? frame;
      const token = top.frameToken;
      const topOrigin = httpsOrigin(top.origin);
      if (!topOrigin) return new Set();
      const hints = new Set([...LOW_ENTROPY, ...(accepted.get(topOrigin) ?? [])]);
      for (const hint of hints) {
        if (hint in details.requestHeaders || (details.resourceType !== 'subFrame' && LOW_ENTROPY.has(hint))) hints.delete(hint);
      }
      if (!hints.size) return hints;
      for (let ancestor: WebFrameMain | null = frame; ancestor; ancestor = ancestor.parent) {
        if (ancestor === frame && details.resourceType === 'subFrame') continue;
        if (ancestor.parent) {
          const policy = documents.get(ancestor.parent.frameTreeNodeId)?.policy ?? (inheritsPolicy(ancestor.parent.url) ? new Map() : undefined);
          const parentOrigin = httpsOrigin(ancestor.parent.origin);
          if (!policy || !parentOrigin) return new Set();
          const currentOrigin = httpsOrigin(ancestor.origin);
          for (const hint of hints) if (!(currentOrigin ? allowsHint(policy, hint, parentOrigin, currentOrigin) : policy.get(hint)?.includes('*') ?? LOW_ENTROPY.has(hint))) hints.delete(hint);
        }
        const document = documents.get(ancestor.frameTreeNodeId);
        if (!document || httpsOrigin(document.url) !== httpsOrigin(ancestor.origin)) {
          if (ancestor === top || !inheritsPolicy(ancestor.url)) return new Set();
          continue;
        }
        const currentOrigin = httpsOrigin(ancestor.origin);
        for (const hint of hints) if (!(currentOrigin ? allowsHint(document.policy, hint, currentOrigin, origin) : LOW_ENTROPY.has(hint))) hints.delete(hint);
      }
      if (!hints.size) return hints;
      let policy: Promise<Set<string>>;
      if (details.resourceType === 'subFrame') policy = readPolicy(contents, frame, origin, true);
      else {
        let cache = policyCache.get(frame);
        if (!cache || cache.token !== frame.frameToken || cache.url !== frame.url) {
          cache = { token: frame.frameToken, url: frame.url, origins: new Map() };
          policyCache.set(frame, cache);
        }
        const origins = cache.origins;
        policy = origins.get(origin) ?? readPolicy(contents, frame, origin, false);
        origins.set(origin, policy);
        trimMap(origins, 32);
        void policy.then((hints) => { if (!hints.size && origins.get(origin) === policy) origins.delete(origin); });
      }
      const allowed = await policy;
      if (top.origin !== topOrigin || top.frameToken !== token) return new Set();
      return new Set([...hints].filter((hint) => allowed.has(hint) && (LOW_ENTROPY.has(hint) || accepted.get(topOrigin)?.has(hint))));
    } catch { return new Set(); }
  }

  const onCookieChanged = (_event: Electron.Event, _cookie: Electron.Cookie, cause: string, removed: boolean) => {
    if (removed && cause !== 'overwrite') accepted.clear();
  };
  session.cookies.on('changed', onCookieChanged);
  const complete = ({ id }: { id: number }) => { requests.delete(id); };
  session.webRequest.onCompleted(complete);
  session.webRequest.onErrorOccurred(complete);
  session.webRequest.onHeadersReceived((details, callback) => {
    const origin = httpsOrigin(details.url);
    const request = requests.get(details.id);
    if (origin) {
      const clear = header(details.responseHeaders, 'clear-site-data')?.join(',');
      const cleared = !!clear && /"(?:\*|cookies|cache|clientHints)"/.test(clear);
      if (cleared) accepted.delete(origin);
      if (!cleared && details.resourceType === 'mainFrame' && request?.generation === generation && request.mainOrigin === origin && request.url === details.url && hasJavaScript(details.webContents) && details.statusCode >= 200 && details.statusCode < 400) {
        const accept = header(details.responseHeaders, 'accept-ch');
        const hints = accept && parseHints(accept.join(','));
        if (hints) {
          accepted.delete(origin);
          if (hints.size) accepted.set(origin, hints);
          trimMap(accepted, 512);
          const navigation = request.navigation;
          if (criticalRetryTrackingComplete && navigation?.restartable && details.method === navigation.method && details.statusCode >= 200 && details.statusCode < 300 && ![204, 205].includes(details.statusCode)) {
            const critical = header(details.responseHeaders, 'critical-ch');
            const required = critical && parseHints(critical.join(','));
            if (required && [...required].some((hint) => hints.has(hint) && !request.sent.has(hint) && !!values[hint])) {
              navigation.restartable = false;
              const responseHeaders = Object.fromEntries(Object.entries(details.responseHeaders ?? {}).filter(([key]) => !['location', 'cache-control', 'content-length', 'content-encoding', 'referrer-policy'].includes(key.toLowerCase())));
              responseHeaders.Location = [details.url];
              responseHeaders['Cache-Control'] = ['no-store'];
              callback({ statusLine: 'HTTP/1.1 307 Temporary Redirect', responseHeaders });
              return;
            }
          }
        }
      }
      if (request?.generation === generation && ['mainFrame', 'subFrame'].includes(details.resourceType) && details.statusCode >= 200 && details.statusCode < 300 && details.frame) {
        documents.set(details.frame.frameTreeNodeId, { url: details.url, policy: parsePolicy(header(details.responseHeaders, 'permissions-policy')) });
        trimMap(documents, 512);
      }
    }
    if (details.statusCode >= 200 && details.statusCode < 300) requests.delete(details.id);
    callback({});
  });
  session.webRequest.onBeforeSendHeaders((details, callback) => {
    const previous = requests.get(details.id);
    if (previous) for (const key of Object.keys(details.requestHeaders)) if (previous.added.has(key.toLowerCase())) delete details.requestHeaders[key];
    const nativeHints = Object.keys(details.requestHeaders).some((key) => HINTS.includes(key.toLowerCase()));
    const headers = details.requestHeaders;
    const replaced = new Set<string>();
    for (const key of Object.keys(headers)) if (Object.hasOwn(values, key.toLowerCase())) { replaced.add(key.toLowerCase()); delete headers[key]; }
    for (const hint of replaced) headers[hint] = values[hint];
    requests.delete(details.id);
    const origin = httpsOrigin(details.url);
    if (requests.size >= 2048) {
      if (details.resourceType === 'mainFrame') criticalRetryTrackingComplete = false;
      callback({ requestHeaders: headers });
      return;
    }
    const request: Request = {
      added: new Set(), mainOrigin: null, url: details.url, generation, sent: new Set(),
      ...(details.resourceType === 'mainFrame' ? { navigation: {
        method: details.method, restartable: previous?.navigation === undefined && ['GET', 'HEAD'].includes(details.method) && !details.uploadData?.length && origin !== null,
      } } : {}),
    };
    if (details.resourceType === 'mainFrame') requests.set(details.id, request);
    const agentHeaders = Object.entries(headers).filter(([key]) => key.toLowerCase() === 'user-agent');
    if (!(origin && agentHeaders.length && agentHeaders.every(([, value]) => value === userAgent) && hasJavaScript(details.webContents) && [...LOW_ENTROPY].every((hint) => !!values[hint]))) {
      callback({ requestHeaders: headers }); return;
    }
    if (!['mainFrame', 'subFrame'].includes(details.resourceType) && !nativeHints) { callback({ requestHeaders: headers }); return; }
    requests.set(details.id, request);
    const apply = (hints: Set<string>) => {
      if (!disposed && requests.get(details.id) === request && request.generation === generation) {
        for (const hint of hints) if (!(hint in headers) && values[hint]) { headers[hint] = values[hint]; request.added.add(hint); }
      }
      if (!request.added.size && !['mainFrame', 'subFrame'].includes(details.resourceType) && requests.get(details.id) === request) requests.delete(details.id);
      request.sent = new Set(Object.keys(headers).map((key) => key.toLowerCase()));
      callback({ requestHeaders: headers });
    };
    if (details.resourceType === 'mainFrame') { request.mainOrigin = origin; apply(new Set([...LOW_ENTROPY, ...(accepted.get(origin) ?? [])])); }
    else void permittedHints(details, origin).then((hints) => {
      if (details.resourceType !== 'subFrame') for (const hint of LOW_ENTROPY) hints.delete(hint);
      apply(hints);
    });
  });
  return () => {
    disposed = true;
    invalidate();
    if (invalidations.get(session) === invalidate) invalidations.delete(session);
    for (const controller of controllers) controller.abort();
    controllers.clear();
    requests.clear();
    session.cookies.removeListener('changed', onCookieChanged);
    session.webRequest.onBeforeSendHeaders(null);
    session.webRequest.onHeadersReceived(null);
    session.webRequest.onCompleted(null);
    session.webRequest.onErrorOccurred(null);
  };
}
