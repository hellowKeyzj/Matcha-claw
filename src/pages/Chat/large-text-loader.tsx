import { useCallback, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import { hostSessionContentLoad } from '@/lib/host-api';
import { buildSessionIdentityKey, type SessionIdentity } from '../../types/desktop/runtime-address';
import type { SessionLargeTextMetadata } from '../../types/session/tool-card';

const LARGE_TEXT_CHUNK_LIMIT = 64 * 1024;

export function useLargeTextContent(input: {
  initialText: string;
  itemKey?: string;
  largeText?: SessionLargeTextMetadata;
  sessionIdentity?: SessionIdentity;
  endpointSessionId?: string | null;
}) {
  const { initialText, itemKey, largeText, sessionIdentity, endpointSessionId } = input;
  const contentRef = largeText?.contentRef ?? null;
  const loadedBytes = largeText?.loadedBytes ?? 0;
  const totalBytes = largeText?.totalBytes ?? 0;
  const identityKey = sessionIdentity ? buildSessionIdentityKey(sessionIdentity) : null;
  const source = useMemo(() => ({ contentRef, loadedBytes, totalBytes, initialText, itemKey, identityKey, endpointSessionId }),
    [contentRef, loadedBytes, totalBytes, initialText, itemKey, identityKey, endpointSessionId]);
  const [state, setState] = useState(() => ({
    source,
    offset: loadedBytes,
    appendedText: '',
    loading: false,
    failed: false,
  }));
  const requestRef = useRef<{ cancelled: boolean } | null>(null);
  useLayoutEffect(() => () => {
    if (requestRef.current) {
      requestRef.current.cancelled = true;
      requestRef.current = null;
    }
  }, [source]);
  const activeState = useMemo(() => state.source === source ? state : {
    source,
    offset: loadedBytes,
    appendedText: '',
    loading: false,
    failed: false,
  }, [loadedBytes, source, state]);
  const complete = !largeText || activeState.offset === totalBytes;

  const loadContent = useCallback(async (all: boolean, onLoaded?: (text: string) => void) => {
    if (!largeText || requestRef.current) return;
    if (complete) {
      onLoaded?.(`${initialText}${activeState.appendedText}`);
      return;
    }
    if (!sessionIdentity) {
      setState({ ...activeState, failed: true });
      return;
    }
    const request = { cancelled: false };
    requestRef.current = request;
    let offset = activeState.offset;
    const parts = [activeState.appendedText];
    setState({ ...activeState, loading: true, failed: false });
    try {
      do {
        const chunk = await hostSessionContentLoad({
          sessionIdentity,
          ...(endpointSessionId ? { endpointSessionId } : {}),
          contentRef: largeText.contentRef,
          offset,
          limit: LARGE_TEXT_CHUNK_LIMIT,
        });
        if (request.cancelled) return;
        if (chunk.contentRef !== largeText.contentRef || chunk.offset !== offset
          || chunk.totalBytes !== totalBytes || chunk.nextOffset === offset) {
          setState({ ...activeState, offset, appendedText: parts.join(''), loading: false, failed: true });
          return;
        }
        offset = chunk.nextOffset;
        parts.push(chunk.text);
      } while (all && offset < totalBytes);
    } catch {
      if (!request.cancelled) {
        setState({ ...activeState, offset, appendedText: parts.join(''), loading: false, failed: true });
      }
      return;
    } finally {
      if (requestRef.current === request) requestRef.current = null;
    }
    const appendedText = parts.join('');
    setState({ ...activeState, offset, appendedText, loading: false, failed: false });
    onLoaded?.(`${initialText}${appendedText}`);
  }, [activeState, complete, endpointSessionId, initialText, largeText, sessionIdentity, totalBytes]);

  return {
    text: `${initialText}${activeState.appendedText}`,
    loading: activeState.loading,
    loadAll: (onLoaded: (text: string) => void) => { void loadContent(true, onLoaded); },
    loadMoreButton: (largeText && !complete && sessionIdentity) || activeState.failed ? (
      <div className="mt-2 flex items-center gap-2">
        {largeText && !complete && sessionIdentity ? (
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="h-7 px-2 text-[12px]"
            disabled={activeState.loading}
            onClick={() => { void loadContent(false); }}
          >
            {activeState.loading ? '加载中…' : '加载更多'}
          </Button>
        ) : null}
        {activeState.failed ? <span role="alert" className="text-[12px] text-muted-foreground">加载失败，请重试</span> : null}
      </div>
    ) : null,
  };
}
