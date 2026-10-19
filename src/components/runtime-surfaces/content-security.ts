import { isRecord } from './sandbox-channel';
import { decodeOpenClawSurfaceError } from '@/types/openclaw-runtime-surface';

export interface ContentCallbacks {
  onSendMessage?: (text: string) => void | Promise<void>;
  onOpenLink?: (url: string) => void | Promise<void>;
}

export function surfaceFailure(error: unknown) {
  return isRecord(error) && isRecord(error.details) ? decodeOpenClawSurfaceError(error.details.surfaceFailure) : null;
}

function frameIsInteractive(frame: HTMLElement): boolean {
  const rect = frame.getBoundingClientRect();
  const style = getComputedStyle(frame);
  return frame.isConnected && document.visibilityState === 'visible' && (frame.tagName === 'IFRAME' ? document.activeElement === frame : frame.contains(document.activeElement))
    && style.display !== 'none' && style.visibility !== 'hidden' && Number(style.opacity) !== 0
    && rect.width > 0 && rect.height > 0 && rect.bottom > 0 && rect.right > 0
    && rect.top < window.innerHeight && rect.left < window.innerWidth;
}

export function safeContentLink(value: unknown): string | null {
  if (typeof value !== 'string' || value.length > 4096 || /[\s\\]/u.test(value)
    || Array.from(value).some((char) => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127)) return null;
  try {
    const url = new URL(value);
    return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password ? url.href : null;
  } catch { return null; }
}

export function createContentActions(
  frame: HTMLElement,
  callbacks: () => ContentCallbacks,
  current: () => boolean,
  authorize: () => Promise<void>,
  confirm: (value: string, kind: 'message' | 'link') => boolean,
) {
  let attempts: number[] = [];
  let busy = false;
  const act = async (value: string, kind: 'message' | 'link', requestCurrent: () => boolean) => {
    const callback = kind === 'message' ? callbacks().onSendMessage : callbacks().onOpenLink;
    const now = Date.now();
    attempts = attempts.filter((time) => now - time < 60_000);
    if (!callback || busy || !current() || !requestCurrent() || !frameIsInteractive(frame) || attempts.length >= 10) return false;
    attempts.push(now);
    busy = true;
    try {
      await authorize();
      if (!current() || !requestCurrent() || !frameIsInteractive(frame) || !confirm(value, kind) || !current() || !requestCurrent()) return false;
      await authorize();
      if (!current() || !requestCurrent() || !frameIsInteractive(frame)) return false;
      await callback(value);
      return current();
    } finally { busy = false; }
  };
  return {
    message: (value: unknown, requestCurrent = current) => {
      if (typeof value !== 'string') return Promise.resolve(false);
      const text = value.trim();
      if (!text || text.length > 4000 || /^[!/]/u.test(text)) return Promise.resolve(false);
      return act(text, 'message', requestCurrent);
    },
    openLink: (value: unknown, requestCurrent = current) => {
      const url = safeContentLink(value);
      return url ? act(url, 'link', requestCurrent) : Promise.resolve(false);
    },
  };
}

export type ContentActions = ReturnType<typeof createContentActions>;

export function contentHostContext(frame: HTMLIFrameElement) {
  return {
    theme: document.documentElement.classList.contains('dark') ? 'dark' : 'light',
    displayMode: 'inline', availableDisplayModes: ['inline'],
    containerDimensions: { width: Math.max(1, frame.clientWidth), height: Math.max(1, frame.clientHeight) },
    locale: navigator.language, timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone, platform: 'desktop',
  };
}
