import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ChatRow } from '@/pages/Chat/chat-row-model';
import { useBodyRenderProjection } from '@/pages/Chat/useBodyRenderProjection';

interface RectShape {
  top: number;
  bottom: number;
  height: number;
  left?: number;
  right?: number;
  width?: number;
}

const viewportRect: RectShape = {
  top: 0,
  bottom: 100,
  height: 100,
  left: 0,
  right: 400,
  width: 400,
};

let rafQueue = new Map<number, FrameRequestCallback>();
let nextRafId = 0;
let viewport: HTMLDivElement;
let content: HTMLDivElement;
let rectByKey: Map<string, RectShape>;

function toDomRect(rect: RectShape): DOMRect {
  return {
    x: rect.left ?? 0,
    y: rect.top,
    top: rect.top,
    bottom: rect.bottom,
    left: rect.left ?? 0,
    right: rect.right ?? (rect.left ?? 0) + (rect.width ?? 0),
    width: rect.width ?? ((rect.right ?? 0) - (rect.left ?? 0)),
    height: rect.height,
    toJSON: () => ({}),
  } as DOMRect;
}

function flushAnimationFrames() {
  const pending = Array.from(rafQueue.values());
  rafQueue.clear();
  for (const callback of pending) {
    callback(0);
  }
}

function buildHeavyRows(count: number): ChatRow[] {
  return Array.from({ length: count }, (_, index) => ({
    key: `row-${index + 1}`,
    kind: 'message' as const,
    message: {
      id: `message-${index + 1}`,
      role: 'assistant' as const,
      content: Array.from(
        { length: 320 },
        (_, line) => `section-${index + 1}-${line}: [OpenAI](https://openai.com) with **bold** text and \`code\``,
      ).join('\n\n'),
      timestamp: index + 1,
    },
  }));
}

function setRowRect(rowKey: string, rect: RectShape) {
  rectByKey.set(rowKey, rect);
}

function mountViewport(rows: ChatRow[]) {
  viewport = document.createElement('div');
  content = document.createElement('div');
  rectByKey = new Map();

  Object.defineProperty(viewport, 'getBoundingClientRect', {
    configurable: true,
    value: () => toDomRect(viewportRect),
  });

  for (const row of rows) {
    if (row.kind !== 'message') {
      continue;
    }
    const element = document.createElement('div');
    element.dataset.chatRowKey = row.key;
    element.dataset.chatRowKind = row.kind;
    rectByKey.set(row.key, {
      top: 1000 + rectByKey.size * 80,
      bottom: 1060 + rectByKey.size * 80,
      height: 60,
      left: 0,
      right: 400,
      width: 400,
    });
    Object.defineProperty(element, 'getBoundingClientRect', {
      configurable: true,
      value: () => toDomRect(rectByKey.get(row.key)!),
    });
    content.appendChild(element);
  }

  viewport.appendChild(content);
  document.body.appendChild(viewport);
}

describe('useBodyRenderProjection', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    rafQueue = new Map();
    nextRafId = 0;
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
      const id = ++nextRafId;
      rafQueue.set(id, callback);
      return id;
    });
    vi.stubGlobal('cancelAnimationFrame', (id: number) => {
      rafQueue.delete(id);
    });
    vi.stubGlobal('ResizeObserver', class {
      observe() {}
      disconnect() {}
      unobserve() {}
    });
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    rafQueue.clear();
    document.body.innerHTML = '';
  });

  it('keeps upgraded full and lite rows from downgrading after they leave the active area', () => {
    const rows = buildHeavyRows(20);
    mountViewport(rows);
    const viewportRef = { current: viewport };
    const contentRef = { current: content };

    const { result, rerender } = renderHook((props: {
      currentSessionKey: string;
      rows: ChatRow[];
      isUserScrolling: boolean;
      scrollDirection: -1 | 0 | 1;
      scrollEventSeq: number;
    }) => useBodyRenderProjection({
      ...props,
      viewportRef,
      contentRef,
    }), {
      initialProps: {
        currentSessionKey: 'agent:test:main:sticky',
        rows,
        isUserScrolling: false,
        scrollDirection: 0,
        scrollEventSeq: 0,
      },
    });

    expect(result.current.bodyRenderModeByRowKey.get('row-1')).toBe('shell');
    expect(result.current.bodyRenderModeByRowKey.get('row-2')).toBe('shell');

    act(() => {
      result.current.requestFullRender('row-1');
    });

    setRowRect('row-2', {
      top: 110,
      bottom: 150,
      height: 40,
      left: 0,
      right: 400,
      width: 400,
    });

    rerender({
      currentSessionKey: 'agent:test:main:sticky',
      rows,
      isUserScrolling: false,
      scrollDirection: 0,
      scrollEventSeq: 1,
    });

    act(() => {
      flushAnimationFrames();
    });

    expect(result.current.bodyRenderModeByRowKey.get('row-1')).toBe('full');
    expect(result.current.bodyRenderModeByRowKey.get('row-2')).toBe('lite');

    setRowRect('row-1', {
      top: 1600,
      bottom: 1660,
      height: 60,
      left: 0,
      right: 400,
      width: 400,
    });
    setRowRect('row-2', {
      top: 1700,
      bottom: 1760,
      height: 60,
      left: 0,
      right: 400,
      width: 400,
    });

    rerender({
      currentSessionKey: 'agent:test:main:sticky',
      rows,
      isUserScrolling: false,
      scrollDirection: 0,
      scrollEventSeq: 2,
    });

    act(() => {
      flushAnimationFrames();
      vi.advanceTimersByTime(500);
    });

    expect(result.current.bodyRenderModeByRowKey.get('row-1')).toBe('full');
    expect(result.current.bodyRenderModeByRowKey.get('row-2')).toBe('lite');
  });

  it('does not promote far tail rows on mount before they enter the viewport band', () => {
    const rows = buildHeavyRows(20);
    mountViewport(rows);
    const viewportRef = { current: viewport };
    const contentRef = { current: content };

    setRowRect('row-19', {
      top: 8,
      bottom: 68,
      height: 60,
      left: 0,
      right: 400,
      width: 400,
    });
    setRowRect('row-20', {
      top: 120,
      bottom: 180,
      height: 60,
      left: 0,
      right: 400,
      width: 400,
    });
    setRowRect('row-18', {
      top: 260,
      bottom: 320,
      height: 60,
      left: 0,
      right: 400,
      width: 400,
    });

    const { result } = renderHook(() => useBodyRenderProjection({
      currentSessionKey: 'agent:test:main:mount-window',
      rows,
      viewportRef,
      contentRef,
      isUserScrolling: false,
      scrollDirection: 0,
      scrollEventSeq: 0,
    }));

    expect(result.current.bodyRenderModeByRowKey.get('row-19')).toBe('full');
    expect(result.current.bodyRenderModeByRowKey.get('row-20')).toBe('lite');
    expect(result.current.bodyRenderModeByRowKey.get('row-18')).toBe('shell');
    expect(result.current.bodyRenderModeByRowKey.get('row-1')).toBe('shell');
  });

  it('upgrades visible rows during scrolling but keeps far rows frozen until scroll idle', () => {
    const rows = buildHeavyRows(20);
    mountViewport(rows);
    const viewportRef = { current: viewport };
    const contentRef = { current: content };

    setRowRect('row-1', {
      top: 12,
      bottom: 72,
      height: 60,
      left: 0,
      right: 400,
      width: 400,
    });
    setRowRect('row-2', {
      top: -88,
      bottom: -28,
      height: 60,
      left: 0,
      right: 400,
      width: 400,
    });
    setRowRect('row-3', {
      top: -240,
      bottom: -180,
      height: 60,
      left: 0,
      right: 400,
      width: 400,
    });

    const { result } = renderHook(() => useBodyRenderProjection({
      currentSessionKey: 'agent:test:main:scrolling',
      rows,
      viewportRef,
      contentRef,
      isUserScrolling: true,
      scrollDirection: -1,
      scrollEventSeq: 1,
    }));

    act(() => {
      flushAnimationFrames();
      vi.advanceTimersByTime(500);
    });

    expect(result.current.bodyRenderModeByRowKey.get('row-1')).toBe('full');
    expect(result.current.bodyRenderModeByRowKey.get('row-2')).toBe('lite');
    expect(result.current.bodyRenderModeByRowKey.get('row-3')).toBe('shell');
  });
});
