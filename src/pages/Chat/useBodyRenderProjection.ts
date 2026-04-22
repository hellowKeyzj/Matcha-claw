import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type RefObject,
} from 'react';
import { scheduleIdleReady } from '@/lib/idle-ready';
import { extractText } from './message-utils';
import { getSessionCacheValue, rememberSessionCacheValue } from './chat-session-cache';
import type { ChatRow } from './chat-row-model';
import { shouldUseLiteMarkdown, type MarkdownBodyRenderMode } from './md-pipeline';

const EMPTY_BODY_RENDER_MODES = new Map<string, MarkdownBodyRenderMode>();
const BODY_RENDER_FULL_RANK = 3;
const BODY_RENDER_LITE_RANK = 2;
const BODY_RENDER_SHELL_RANK = 1;
const ACTIVE_NEARBY_VIEWPORT_FACTOR = 0.35;
const ACTIVE_DIRECTION_BIAS_FACTOR = 0.7;
const IDLE_NEARBY_VIEWPORT_FACTOR = 0.9;
const IDLE_DIRECTION_BIAS_FACTOR = 1.15;

interface DeferredAssistantRow {
  key: string;
}

interface SessionBodyRenderCache {
  modes: Map<string, MarkdownBodyRenderMode>;
}

interface UseBodyRenderProjectionInput {
  currentSessionKey: string;
  rows: ChatRow[];
  viewportRef: RefObject<HTMLDivElement | null>;
  contentRef: RefObject<HTMLDivElement | null>;
  isUserScrolling: boolean;
  scrollDirection: -1 | 0 | 1;
  scrollEventSeq: number;
}

const globalBodyRenderCache = new Map<string, SessionBodyRenderCache>();

function getBodyRenderRank(mode: MarkdownBodyRenderMode): number {
  switch (mode) {
    case 'full':
      return BODY_RENDER_FULL_RANK;
    case 'lite':
      return BODY_RENDER_LITE_RANK;
    default:
      return BODY_RENDER_SHELL_RANK;
  }
}

function promoteBodyRenderMode(
  current: MarkdownBodyRenderMode | undefined,
  target: MarkdownBodyRenderMode,
): MarkdownBodyRenderMode {
  if (!current) {
    return target;
  }
  return getBodyRenderRank(current) >= getBodyRenderRank(target) ? current : target;
}

function areModeMapsEqual(
  left: ReadonlyMap<string, MarkdownBodyRenderMode>,
  right: ReadonlyMap<string, MarkdownBodyRenderMode>,
): boolean {
  if (left.size !== right.size) {
    return false;
  }
  for (const [key, value] of left.entries()) {
    if (right.get(key) !== value) {
      return false;
    }
  }
  return true;
}

function rememberBodyRenderCache(
  sessionKey: string,
  modes: ReadonlyMap<string, MarkdownBodyRenderMode>,
): void {
  rememberSessionCacheValue(globalBodyRenderCache, sessionKey, {
    modes: new Map(modes),
  });
}

function buildDeferredAssistantRows(rows: ChatRow[]): DeferredAssistantRow[] {
  const deferredRows: DeferredAssistantRow[] = [];
  for (const row of rows) {
    if (row.kind !== 'message') {
      continue;
    }
    const role = typeof row.message.role === 'string' ? row.message.role.toLowerCase() : '';
    if (role !== 'assistant') {
      continue;
    }
    const text = extractText(row.message);
    if (!text.trim()) {
      continue;
    }
    if (!shouldUseLiteMarkdown(text, false)) {
      continue;
    }
    deferredRows.push({
      key: row.key,
    });
  }
  return deferredRows;
}

function buildInitialBodyRenderModes(
  sessionKey: string,
  deferredRows: DeferredAssistantRow[],
): Map<string, MarkdownBodyRenderMode> {
  const cached = getSessionCacheValue(globalBodyRenderCache, sessionKey);
  const next = new Map<string, MarkdownBodyRenderMode>();

  for (const row of deferredRows) {
    const cachedMode = cached?.modes.get(row.key);
    next.set(row.key, cachedMode ?? 'shell');
  }

  rememberBodyRenderCache(sessionKey, next);
  return next;
}

function collectDeferredAssistantRowKeys(
  elements: Iterable<HTMLElement>,
  deferredRowKeySet: ReadonlySet<string>,
  viewportRect: DOMRect,
  direction: -1 | 0 | 1,
  nearbyViewportFactor: number,
  directionBiasFactor: number,
): {
  fullKeys: Set<string>;
  liteKeys: Set<string>;
} {
  const fullKeys = new Set<string>();
  const liteKeys = new Set<string>();
  const viewportHeight = Math.max(0, viewportRect.height);
  const nearbyPx = viewportHeight * nearbyViewportFactor;
  const directionBiasPx = viewportHeight * directionBiasFactor;
  const warmTop = viewportRect.top - nearbyPx - (direction < 0 ? directionBiasPx : 0);
  const warmBottom = viewportRect.bottom + nearbyPx + (direction > 0 ? directionBiasPx : 0);

  for (const element of elements) {
    const rowKey = element.dataset.chatRowKey;
    if (!rowKey || !deferredRowKeySet.has(rowKey)) {
      continue;
    }
    const rect = element.getBoundingClientRect();
    const intersectsViewport = rect.bottom >= viewportRect.top && rect.top <= viewportRect.bottom;
    if (intersectsViewport) {
      fullKeys.add(rowKey);
      liteKeys.add(rowKey);
      continue;
    }
    const intersectsWarmBand = rect.bottom >= warmTop && rect.top <= warmBottom;
    if (intersectsWarmBand) {
      liteKeys.add(rowKey);
    }
  }

  return {
    fullKeys,
    liteKeys,
  };
}

function promoteModeMap(
  previous: ReadonlyMap<string, MarkdownBodyRenderMode>,
  fullKeys: ReadonlySet<string>,
  liteKeys: ReadonlySet<string>,
): Map<string, MarkdownBodyRenderMode> | null {
  let changed = false;
  const next = new Map(previous);

  for (const key of liteKeys) {
    const promoted = promoteBodyRenderMode(next.get(key), 'lite');
    if (promoted !== next.get(key)) {
      next.set(key, promoted);
      changed = true;
    }
  }

  for (const key of fullKeys) {
    const promoted = promoteBodyRenderMode(next.get(key), 'full');
    if (promoted !== next.get(key)) {
      next.set(key, promoted);
      changed = true;
    }
  }

  return changed ? next : null;
}

export function useBodyRenderProjection({
  currentSessionKey,
  rows,
  viewportRef,
  contentRef,
  isUserScrolling,
  scrollDirection,
  scrollEventSeq,
}: UseBodyRenderProjectionInput): {
  bodyRenderModeByRowKey: ReadonlyMap<string, MarkdownBodyRenderMode>;
  requestFullRender: (rowKey: string) => void;
} {
  const deferredRows = useMemo(
    () => buildDeferredAssistantRows(rows),
    [rows],
  );
  const deferredRowKeySet = useMemo(
    () => new Set(deferredRows.map((row) => row.key)),
    [deferredRows],
  );
  const [bodyRenderModeByRowKey, setBodyRenderModeByRowKey] = useState<Map<string, MarkdownBodyRenderMode>>(
    () => buildInitialBodyRenderModes(currentSessionKey, deferredRows),
  );
  const idleUpgradeCancelRef = useRef<(() => void) | null>(null);
  const rafIdRef = useRef<number | null>(null);

  useEffect(() => {
    rememberBodyRenderCache(currentSessionKey, bodyRenderModeByRowKey);
  }, [bodyRenderModeByRowKey, currentSessionKey]);

  const buildPromotedModeMap = useCallback((
    previous: ReadonlyMap<string, MarkdownBodyRenderMode>,
    reason: 'active' | 'idle',
  ): Map<string, MarkdownBodyRenderMode> | null => {
    const viewport = viewportRef.current;
    if (!viewport || deferredRowKeySet.size === 0) {
      return null;
    }
    const elements = viewport.querySelectorAll<HTMLElement>('[data-chat-row-key][data-chat-row-kind="message"]');
    if (elements.length === 0) {
      return null;
    }
    const viewportRect = viewport.getBoundingClientRect();
    if (viewportRect.height <= 0 && viewport.clientHeight <= 0) {
      return null;
    }
    const { fullKeys, liteKeys } = collectDeferredAssistantRowKeys(
      elements,
      deferredRowKeySet,
      viewportRect.height > 0 ? viewportRect : DOMRect.fromRect({
        x: 0,
        y: 0,
        width: viewport.clientWidth,
        height: viewport.clientHeight,
      }),
      scrollDirection,
      reason === 'idle' ? IDLE_NEARBY_VIEWPORT_FACTOR : ACTIVE_NEARBY_VIEWPORT_FACTOR,
      reason === 'idle' ? IDLE_DIRECTION_BIAS_FACTOR : ACTIVE_DIRECTION_BIAS_FACTOR,
    );
    if (fullKeys.size === 0 && liteKeys.size === 0) {
      return null;
    }
    return promoteModeMap(previous, fullKeys, liteKeys);
  }, [deferredRowKeySet, scrollDirection, viewportRef]);

  const promoteVisibleRows = useCallback((reason: 'active' | 'idle') => {
    setBodyRenderModeByRowKey((previous) => {
      const promoted = buildPromotedModeMap(previous, reason);
      return promoted ?? previous;
    });
  }, [buildPromotedModeMap]);

  const scheduleIdleUpgrade = useCallback(() => {
    idleUpgradeCancelRef.current?.();
    idleUpgradeCancelRef.current = scheduleIdleReady(() => {
      idleUpgradeCancelRef.current = null;
      promoteVisibleRows('idle');
    }, {
      idleTimeoutMs: 320,
      fallbackDelayMs: 140,
    });
  }, [promoteVisibleRows]);

  const scheduleActiveScan = useCallback(() => {
    if (typeof window === 'undefined' || typeof window.requestAnimationFrame !== 'function') {
      promoteVisibleRows('active');
      return;
    }
    if (rafIdRef.current != null) {
      return;
    }
    rafIdRef.current = window.requestAnimationFrame(() => {
      rafIdRef.current = null;
      promoteVisibleRows('active');
    });
  }, [promoteVisibleRows]);

  useLayoutEffect(() => {
    setBodyRenderModeByRowKey((previous) => {
      const base = buildInitialBodyRenderModes(currentSessionKey, deferredRows);
      const promoted = buildPromotedModeMap(base, 'active') ?? base;
      return areModeMapsEqual(previous, promoted) ? previous : promoted;
    });
  }, [buildPromotedModeMap, currentSessionKey, deferredRows]);

  useEffect(() => {
    if (scrollEventSeq <= 0) {
      return;
    }
    scheduleActiveScan();
  }, [scheduleActiveScan, scrollEventSeq]);

  useEffect(() => {
    idleUpgradeCancelRef.current?.();
    if (isUserScrolling) {
      return;
    }
    scheduleIdleUpgrade();
  }, [isUserScrolling, scheduleIdleUpgrade]);

  useEffect(() => {
    const viewport = viewportRef.current;
    const content = contentRef.current;
    if (typeof ResizeObserver !== 'function' || (!viewport && !content)) {
      return;
    }
    const observer = new ResizeObserver(() => {
      scheduleActiveScan();
      if (!isUserScrolling) {
        scheduleIdleUpgrade();
      }
    });
    if (viewport) {
      observer.observe(viewport);
    }
    if (content) {
      observer.observe(content);
    }
    return () => observer.disconnect();
  }, [contentRef, isUserScrolling, scheduleActiveScan, scheduleIdleUpgrade, viewportRef]);

  useEffect(() => {
    return () => {
      if (rafIdRef.current != null && typeof window !== 'undefined' && typeof window.cancelAnimationFrame === 'function') {
        window.cancelAnimationFrame(rafIdRef.current);
      }
      idleUpgradeCancelRef.current?.();
    };
  }, []);

  const requestFullRender = useCallback((rowKey: string) => {
    if (!rowKey || !deferredRowKeySet.has(rowKey)) {
      return;
    }
    setBodyRenderModeByRowKey((previous) => {
      const next = new Map(previous);
      const promoted = promoteBodyRenderMode(next.get(rowKey), 'full');
      if (promoted === next.get(rowKey)) {
        return previous;
      }
      next.set(rowKey, promoted);
      return next;
    });
  }, [deferredRowKeySet]);

  return {
    bodyRenderModeByRowKey: deferredRows.length > 0 ? bodyRenderModeByRowKey : EMPTY_BODY_RENDER_MODES,
    requestFullRender,
  };
}
