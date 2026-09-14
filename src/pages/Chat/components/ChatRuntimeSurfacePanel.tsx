import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent, type KeyboardEvent, type MouseEvent, type WheelEvent } from 'react';
import { AlertCircle, Keyboard, Loader2, MousePointerClick, PanelTopOpen, RefreshCw, SquareActivity } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import { hostOpenClawBrowserRequest, hostOpenClawMcpAppRequest } from '@/lib/host-api';
import type { ChatRuntimeSurfaceDescriptor } from '../useChatSidePanelController';

const SIDE_PANEL_CONTENT_PAD_X = 'px-3';
const SIDE_PANEL_CONTENT_PAD_Y = 'py-3';
const BROWSER_REQUEST_TIMEOUT_MS = 15_000;
const BROWSER_REFRESH_TIMEOUT_MS = 20_000;

type BrowserSurface = Extract<ChatRuntimeSurfaceDescriptor, { readonly kind: 'browser-tab' }>;
type McpSurface = Extract<ChatRuntimeSurfaceDescriptor, { readonly kind: 'mcp-app' }>;

type BrowserTabView = {
  readonly targetId: string;
  readonly title?: string;
  readonly url?: string;
  readonly active?: boolean;
};

type BrowserScreenshotView = {
  readonly dataUrl: string;
  readonly targetId?: string;
  readonly url?: string;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function readText(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function readBoolean(value: unknown): boolean | undefined {
  return typeof value === 'boolean' ? value : undefined;
}

function readHttpUrl(value: unknown): string | undefined {
  const text = readText(value);
  if (!text) {
    return undefined;
  }
  try {
    const url = new URL(text);
    return url.protocol === 'http:' || url.protocol === 'https:' ? text : undefined;
  } catch {
    return undefined;
  }
}

function readImageDataUrl(value: unknown): string | undefined {
  const text = readText(value);
  if (!text || text.length > 8 * 1024 * 1024 || !/^data:image\/(png|jpeg);base64,[A-Za-z0-9+/]*={0,2}$/u.test(text)) {
    return undefined;
  }
  return text;
}

function readBase64Image(value: unknown, type: unknown): string | undefined {
  const text = readText(value);
  if (!text || text.length > 8 * 1024 * 1024 || !/^[A-Za-z0-9+/]*={0,2}$/u.test(text)) {
    return undefined;
  }
  const imageType = type === 'jpeg' ? 'jpeg' : 'png';
  return `data:image/${imageType};base64,${text}`;
}

function readBrowserTabs(value: unknown): BrowserTabView[] {
  const tabs = isRecord(value) && Array.isArray(value.tabs) ? value.tabs : [];
  return tabs.flatMap((entry) => {
    if (!isRecord(entry)) {
      return [];
    }
    const targetId = readText(entry.targetId);
    if (!targetId) {
      return [];
    }
    const title = readText(entry.title);
    const url = readText(entry.url);
    const active = readBoolean(entry.active);
    return [{
      targetId,
      ...(title ? { title } : {}),
      ...(url ? { url } : {}),
      ...(active !== undefined ? { active } : {}),
    }];
  });
}

function readBrowserScreenshot(value: unknown): BrowserScreenshotView | null {
  if (!isRecord(value)) {
    return null;
  }
  const dataUrl = readImageDataUrl(value.dataUrl) ?? readBase64Image(value.imageBase64, value.imageType);
  if (!dataUrl) {
    return null;
  }
  const targetId = readText(value.targetId);
  const url = readText(value.url);
  return {
    dataUrl,
    ...(targetId ? { targetId } : {}),
    ...(url ? { url } : {}),
  };
}

function RuntimeMetadataRow({ label, value }: { label: string; value?: string | number }) {
  if (value === undefined || value === '') {
    return null;
  }
  return (
    <div className="grid grid-cols-[5.5rem_minmax(0,1fr)] gap-2 text-xs leading-5">
      <span className="text-muted-foreground">{label}</span>
      <span className="min-w-0 break-words text-foreground">{String(value)}</span>
    </div>
  );
}

function browserRequestInput(
  surface: BrowserSurface,
  method: 'GET' | 'POST' | 'DELETE',
  path: string,
  body?: Record<string, unknown>,
  timeoutMs?: number,
) {
  return {
    method,
    path,
    ...(surface.profile ? { query: { profile: surface.profile } } : {}),
    ...(body ? { body } : {}),
    ...(timeoutMs ? { timeoutMs } : {}),
    target: surface.target,
    ...(surface.target === 'node' && surface.node ? { node: surface.node } : {}),
  };
}

function resolveTargetId(surface: BrowserSurface, selectedTargetId: string | null, tabs: BrowserTabView[]): string {
  return selectedTargetId ?? surface.targetId ?? tabs[0]?.targetId ?? '';
}

function resolveAvailableTargetId(
  tabs: BrowserTabView[],
  preferredTargetId?: string | null,
  selectedTargetId?: string | null,
  surfaceTargetId?: string,
): string {
  const tabIds = new Set(tabs.map((tab) => tab.targetId));
  return [preferredTargetId, selectedTargetId, surfaceTargetId].find((targetId) => targetId && tabIds.has(targetId))
    ?? tabs[0]?.targetId
    ?? '';
}

function BrowserRuntimePanel({ surface }: { surface: BrowserSurface }) {
  const [tabs, setTabs] = useState<BrowserTabView[]>([]);
  const [selectedTargetId, setSelectedTargetId] = useState<string | null>(surface.targetId);
  const [urlInput, setUrlInput] = useState(surface.url ?? '');
  const [screenshot, setScreenshot] = useState<BrowserScreenshotView | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const previewRef = useRef<HTMLDivElement | null>(null);
  const wheelBusyRef = useRef(false);
  const title = surface.title ?? '浏览器标签页';
  const currentTargetId = resolveTargetId(surface, selectedTargetId, tabs);

  const requestBrowser = useCallback(async <T,>(
    method: 'GET' | 'POST' | 'DELETE',
    path: string,
    body?: Record<string, unknown>,
    timeoutMs = BROWSER_REQUEST_TIMEOUT_MS,
  ) => hostOpenClawBrowserRequest<T>(
    browserRequestInput(surface, method, path, body, timeoutMs),
    { timeoutMs: Math.max(timeoutMs + 5_000, BROWSER_REFRESH_TIMEOUT_MS) },
  ), [surface]);

  const captureScreenshot = useCallback(async (targetId: string) => {
    if (!targetId) {
      return;
    }
    const result = await requestBrowser<unknown>('POST', '/screenshot', { targetId, type: 'png' }, BROWSER_REQUEST_TIMEOUT_MS);
    const nextScreenshot = readBrowserScreenshot(result);
    if (!nextScreenshot) {
      throw new Error('截图结果不可显示。');
    }
    setScreenshot(nextScreenshot);
    if (nextScreenshot.url) {
      setUrlInput(nextScreenshot.url);
    }
    if (nextScreenshot.targetId) {
      setSelectedTargetId(nextScreenshot.targetId);
    }
  }, [requestBrowser]);

  const refreshBrowser = useCallback(async (preferredTargetId?: string) => {
    setBusy(true);
    setError(null);
    try {
      const tabsResult = await requestBrowser<unknown>('GET', '/tabs', undefined, 10_000);
      const nextTabs = readBrowserTabs(tabsResult);
      setTabs(nextTabs);
      const targetId = resolveAvailableTargetId(nextTabs, preferredTargetId, selectedTargetId, surface.targetId);
      setSelectedTargetId(targetId || null);
      if (targetId) {
        await captureScreenshot(targetId);
      }
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setBusy(false);
    }
  }, [captureScreenshot, requestBrowser, selectedTargetId, surface.targetId]);

  useEffect(() => {
    setSelectedTargetId(surface.targetId);
    setUrlInput(surface.url ?? '');
    setScreenshot(null);
    setBusy(true);
    setError(null);
    void (async () => {
      try {
        const tabsResult = await requestBrowser<unknown>('GET', '/tabs', undefined, 10_000);
        const nextTabs = readBrowserTabs(tabsResult);
        setTabs(nextTabs);
        const targetId = resolveAvailableTargetId(nextTabs, surface.targetId, null, surface.targetId);
        setSelectedTargetId(targetId || null);
        if (targetId) {
          await captureScreenshot(targetId);
        }
      } catch (caught) {
        setError(caught instanceof Error ? caught.message : String(caught));
      } finally {
        setBusy(false);
      }
    })();
  }, [captureScreenshot, requestBrowser, surface.targetId, surface.url]);

  const runAndRefresh = useCallback(async (operation: () => Promise<string | void>) => {
    setBusy(true);
    setError(null);
    try {
      const targetId = await operation();
      await refreshBrowser(targetId || currentTargetId);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setBusy(false);
    }
  }, [currentTargetId, refreshBrowser]);

  const handleStart = () => {
    void runAndRefresh(async () => {
      await requestBrowser('POST', '/start', {});
    });
  };

  const handleOpenTab = () => {
    const url = urlInput.trim() || 'about:blank';
    void runAndRefresh(async () => {
      const result = await requestBrowser<unknown>('POST', '/tabs/open', { url });
      return isRecord(result) ? readText(result.targetId) : undefined;
    });
  };

  const handleNavigate = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const url = urlInput.trim();
    if (!url || !currentTargetId) {
      return;
    }
    void runAndRefresh(async () => {
      const result = await requestBrowser<unknown>('POST', '/navigate', { targetId: currentTargetId, url });
      return isRecord(result) ? readText(result.targetId) : undefined;
    });
  };

  const handleReload = () => {
    const url = urlInput.trim() || screenshot?.url;
    if (!url || !currentTargetId) {
      void refreshBrowser(currentTargetId);
      return;
    }
    void runAndRefresh(async () => {
      await requestBrowser('POST', '/navigate', { targetId: currentTargetId, url });
      return currentTargetId;
    });
  };

  const handleFocusTab = (targetId: string) => {
    setSelectedTargetId(targetId);
    void runAndRefresh(async () => {
      await requestBrowser('POST', '/tabs/focus', { targetId });
      return targetId;
    });
  };

  const handleCloseTab = (targetId: string) => {
    void runAndRefresh(async () => {
      await requestBrowser('DELETE', `/tabs/${encodeURIComponent(targetId)}`);
    });
  };

  const handleScreenshotClick = (event: MouseEvent<HTMLImageElement>) => {
    if (!currentTargetId) {
      return;
    }
    const bounds = event.currentTarget.getBoundingClientRect();
    const x = Math.max(0, Math.round(((event.clientX - bounds.left) / Math.max(1, bounds.width)) * event.currentTarget.naturalWidth));
    const y = Math.max(0, Math.round(((event.clientY - bounds.top) / Math.max(1, bounds.height)) * event.currentTarget.naturalHeight));
    void runAndRefresh(async () => {
      await requestBrowser('POST', '/act', { kind: 'clickCoords', targetId: currentTargetId, x, y });
      return currentTargetId;
    });
  };

  const handlePreviewKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (!currentTargetId || event.ctrlKey || event.altKey || event.metaKey) {
      return;
    }
    const key = event.key.length === 1 || ['Enter', 'Escape', 'Backspace', 'Delete', 'Tab', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].includes(event.key)
      ? event.key
      : '';
    if (!key) {
      return;
    }
    event.preventDefault();
    void runAndRefresh(async () => {
      await requestBrowser('POST', '/act', { kind: 'press', targetId: currentTargetId, key });
      return currentTargetId;
    });
  };

  const handlePreviewWheel = (event: WheelEvent<HTMLDivElement>) => {
    if (!currentTargetId || wheelBusyRef.current || Math.abs(event.deltaY) < 1) {
      return;
    }
    event.preventDefault();
    wheelBusyRef.current = true;
    void runAndRefresh(async () => {
      await requestBrowser('POST', '/act', {
        kind: 'scroll',
        targetId: currentTargetId,
        scrollDirection: event.deltaY > 0 ? 'down' : 'up',
        scrollAmount: Math.min(1200, Math.max(80, Math.round(Math.abs(event.deltaY)))),
      });
      return currentTargetId;
    }).finally(() => {
      wheelBusyRef.current = false;
    });
  };

  const handleResizeViewport = () => {
    const bounds = previewRef.current?.getBoundingClientRect();
    if (!currentTargetId || !bounds) {
      return;
    }
    void runAndRefresh(async () => {
      await requestBrowser('POST', '/act', {
        kind: 'resize',
        targetId: currentTargetId,
        width: Math.max(320, Math.round(bounds.width)),
        height: Math.max(240, Math.round(bounds.height)),
      });
      return currentTargetId;
    });
  };

  const selectedTab = useMemo(
    () => tabs.find((tab) => tab.targetId === currentTargetId),
    [currentTargetId, tabs],
  );

  return (
    <div className={cn('flex min-h-0 flex-1 flex-col gap-3 overflow-hidden', SIDE_PANEL_CONTENT_PAD_X, SIDE_PANEL_CONTENT_PAD_Y)}>
      <div className="rounded-xl border border-border/60 bg-background px-3 py-3">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <p className="truncate text-sm font-medium text-foreground" title={title}>{title}</p>
            <p className="mt-1 truncate text-xs text-muted-foreground" title={selectedTab?.url ?? surface.url}>{selectedTab?.url ?? surface.url ?? 'Browser Tab 运行面'}</p>
          </div>
          <Button type="button" variant="ghost" size="icon" className="h-8 w-8 shrink-0 rounded-md" onClick={() => void refreshBrowser(currentTargetId)} disabled={busy} aria-label="刷新浏览器运行面" title="刷新浏览器运行面">
            <RefreshCw className={cn('h-4 w-4', busy && 'animate-spin')} />
          </Button>
        </div>
        <form className="mt-3 flex gap-2" onSubmit={handleNavigate}>
          <input
            value={urlInput}
            onChange={(event) => setUrlInput(event.currentTarget.value)}
            className="min-w-0 flex-1 rounded-lg border border-border/60 bg-muted/20 px-3 py-2 text-xs text-foreground outline-none focus:border-border"
            placeholder="https://example.com"
          />
          <Button type="submit" size="sm" className="h-8 px-3" disabled={busy || !currentTargetId}>跳转</Button>
          <Button type="button" variant="secondary" size="sm" className="h-8 px-3" onClick={handleOpenTab} disabled={busy}>新开</Button>
        </form>
        <div className="mt-3 flex flex-wrap gap-2">
          <Button type="button" variant="secondary" size="sm" className="h-8 gap-1.5 px-3" onClick={handleStart} disabled={busy}>
            <PanelTopOpen className="h-3.5 w-3.5" />
            启动
          </Button>
          <Button type="button" variant="secondary" size="sm" className="h-8 gap-1.5 px-3" onClick={handleReload} disabled={busy || !currentTargetId}>
            <RefreshCw className="h-3.5 w-3.5" />
            重载
          </Button>
          <Button type="button" variant="secondary" size="sm" className="h-8 gap-1.5 px-3" onClick={handleResizeViewport} disabled={busy || !currentTargetId}>
            <SquareActivity className="h-3.5 w-3.5" />
            同步尺寸
          </Button>
        </div>
        <div className="mt-3 space-y-1.5 rounded-lg bg-muted/30 px-3 py-2">
          <RuntimeMetadataRow label="target" value={surface.target} />
          <RuntimeMetadataRow label="targetId" value={currentTargetId} />
          <RuntimeMetadataRow label="profile" value={surface.profile} />
          <RuntimeMetadataRow label="node" value={surface.node} />
          <RuntimeMetadataRow label="tool" value={surface.toolName} />
        </div>
      </div>

      {tabs.length > 0 ? (
        <div className="flex shrink-0 gap-2 overflow-x-auto pb-1">
          {tabs.map((tab) => (
            <div key={tab.targetId} className={cn('flex min-w-[180px] max-w-[240px] items-center gap-1 rounded-lg border px-2 py-1.5', tab.targetId === currentTargetId ? 'border-border bg-secondary' : 'border-border/50 bg-muted/20')}>
              <button type="button" className="min-w-0 flex-1 text-left" onClick={() => handleFocusTab(tab.targetId)}>
                <p className="truncate text-xs font-medium text-foreground" title={tab.title}>{tab.title ?? 'Untitled'}</p>
                <p className="truncate text-[11px] text-muted-foreground" title={tab.url}>{tab.url ?? tab.targetId}</p>
              </button>
              <button type="button" className="shrink-0 rounded px-1 text-xs text-muted-foreground hover:bg-background hover:text-foreground" onClick={() => handleCloseTab(tab.targetId)} aria-label="关闭标签页">×</button>
            </div>
          ))}
        </div>
      ) : null}

      {error ? (
        <div className="rounded-lg border border-destructive/30 bg-destructive/8 px-3 py-2 text-xs text-destructive">
          <span className="inline-flex items-start gap-2"><AlertCircle className="mt-0.5 h-3.5 w-3.5 shrink-0" />{error}</span>
        </div>
      ) : null}

      <div
        ref={previewRef}
        role="button"
        tabIndex={0}
        className="relative flex min-h-[260px] flex-1 items-center justify-center overflow-hidden rounded-xl border border-border/60 bg-muted/20 outline-none focus:border-border"
        onKeyDown={handlePreviewKeyDown}
        onWheel={handlePreviewWheel}
        aria-label="浏览器截图运行面"
      >
        {busy && !screenshot ? <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" /> : null}
        {screenshot ? (
          <img
            data-testid="chat-runtime-browser-screenshot"
            src={screenshot.dataUrl}
            alt={title}
            className="max-h-full max-w-full cursor-crosshair select-none object-contain"
            draggable={false}
            onClick={handleScreenshotClick}
          />
        ) : !busy ? (
          <div className="px-6 text-center text-sm text-muted-foreground">暂无浏览器截图，启动或刷新后预览。</div>
        ) : null}
        <div className="pointer-events-none absolute bottom-2 left-2 inline-flex items-center gap-1 rounded-full border border-border/50 bg-background/88 px-2 py-1 text-[11px] text-muted-foreground shadow-sm">
          <MousePointerClick className="h-3 w-3" /> 点击截图操作页面
          <span className="mx-1 text-border">|</span>
          <Keyboard className="h-3 w-3" /> 聚焦后转发按键/滚轮
        </div>
      </div>
    </div>
  );
}

type McpViewState =
  | { readonly key: string; readonly status: 'ready'; readonly standaloneUrl: string }
  | { readonly key: string; readonly status: 'error'; readonly error: string };

function McpRuntimePanel({ surface }: { surface: McpSurface }) {
  const viewId = surface.viewId ?? surface.mcpApp?.viewId;
  const sessionKey = surface.mcpApp?.originSessionKey;
  const requestKey = sessionKey && viewId ? `${sessionKey}:${viewId}` : null;
  const [viewState, setViewState] = useState<McpViewState | null>(null);
  const title = surface.title ?? surface.mcpApp?.toolName ?? surface.toolName ?? 'MCP App';
  const activeViewState = !requestKey
    ? { key: '', status: 'error' as const, error: 'MCP App 缺少运行面租约。' }
    : viewState?.key === requestKey
      ? viewState
      : { key: requestKey, status: 'loading' as const };
  const loading = activeViewState.status === 'loading';
  const error = activeViewState.status === 'error' ? activeViewState.error : null;
  const standaloneUrl = activeViewState.status === 'ready' ? activeViewState.standaloneUrl : null;

  useEffect(() => {
    if (!requestKey || !sessionKey || !viewId) {
      return;
    }
    let cancelled = false;
    void hostOpenClawMcpAppRequest<unknown>({
      operationId: 'mcp.app.view',
      sessionKey,
      viewId,
      standalone: true,
    }, { timeoutMs: 20_000 }).then((result) => {
      if (cancelled) {
        return;
      }
      const url = isRecord(result) ? readHttpUrl(result.standaloneUrl) : undefined;
      setViewState(url
        ? { key: requestKey, status: 'ready', standaloneUrl: url }
        : { key: requestKey, status: 'error', error: 'MCP App 当前没有可用独立预览。' });
    }).catch((caught) => {
      if (!cancelled) {
        setViewState({ key: requestKey, status: 'error', error: caught instanceof Error ? caught.message : String(caught) });
      }
    });
    return () => {
      cancelled = true;
    };
  }, [requestKey, sessionKey, viewId]);

  return (
    <div className={cn('flex min-h-0 flex-1 flex-col gap-3 overflow-hidden', SIDE_PANEL_CONTENT_PAD_X, SIDE_PANEL_CONTENT_PAD_Y)}>
      <div className="rounded-xl border border-border/60 bg-background px-3 py-3">
        <div className="flex items-start gap-2">
          <SquareActivity className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" />
          <div className="min-w-0">
            <p className="truncate text-sm font-medium text-foreground" title={title}>{title}</p>
            <p className="mt-1 text-xs text-muted-foreground">MCP App 运行面</p>
          </div>
        </div>
        <div className="mt-3 space-y-1.5 rounded-lg bg-muted/30 px-3 py-2">
          <RuntimeMetadataRow label="viewId" value={viewId} />
          <RuntimeMetadataRow label="server" value={surface.mcpApp?.serverName} />
          <RuntimeMetadataRow label="target" value={surface.surface} />
          <RuntimeMetadataRow label="tool" value={surface.mcpApp?.toolName ?? surface.toolName} />
          <RuntimeMetadataRow label="resource" value={surface.mcpApp?.uiResourceUri} />
          <RuntimeMetadataRow label="sandbox" value={surface.sandbox} />
          <RuntimeMetadataRow label="height" value={surface.preferredHeight} />
          <RuntimeMetadataRow label="widget" value={surface.boardWidgetName} />
          <RuntimeMetadataRow label="state" value={surface.mcpApp?.resultMetaState} />
        </div>
      </div>
      {error ? (
        <div className="rounded-lg border border-destructive/30 bg-destructive/8 px-3 py-2 text-xs text-destructive">
          <span className="inline-flex items-start gap-2"><AlertCircle className="mt-0.5 h-3.5 w-3.5 shrink-0" />{error}</span>
        </div>
      ) : null}
      <div className="min-h-[260px] flex-1 overflow-hidden rounded-xl border border-border/60 bg-muted/20">
        {loading ? (
          <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
            <Loader2 className="mr-2 h-4 w-4 animate-spin" />正在加载 MCP App…
          </div>
        ) : standaloneUrl ? (
          <iframe
            title={title}
            src={standaloneUrl}
            sandbox="allow-scripts allow-same-origin allow-forms"
            referrerPolicy="no-referrer"
            className="h-full w-full border-0 bg-background"
          />
        ) : !error ? (
          <div className="flex h-full items-center justify-center px-6 text-center text-sm text-muted-foreground">暂无可用 MCP App 预览。</div>
        ) : null}
      </div>
    </div>
  );
}

export function ChatRuntimeSurfacePanel({ surface }: { surface: ChatRuntimeSurfaceDescriptor | null }) {
  if (!surface) {
    return (
      <div className="flex h-full items-center justify-center px-6 text-center text-sm text-muted-foreground">
        点击 Browser Tab 或 MCP App 工具卡片后在这里预览运行面。
      </div>
    );
  }
  return surface.kind === 'browser-tab'
    ? <BrowserRuntimePanel surface={surface} />
    : <McpRuntimePanel surface={surface} />;
}
