import { useCallback, useMemo, useState } from 'react';
import { Button } from '@/components/ui/button';
import { hostSessionContentLoad } from '@/lib/host-api';
import type { SessionIdentity } from '../../../electron/desktop-contract/runtime-address';
import type { SessionLargeTextMetadata } from '../../types/session/tool-card';

const LARGE_TEXT_CHUNK_LIMIT = 64 * 1024;

export function useLargeTextContent(input: {
  initialText: string;
  largeText?: SessionLargeTextMetadata;
  sessionIdentity?: SessionIdentity;
  endpointSessionId?: string | null;
}) {
  const { initialText, largeText, sessionIdentity, endpointSessionId } = input;
  const [state, setState] = useState(() => ({
    contentRef: largeText?.contentRef ?? null,
    loadedBytes: largeText?.loadedBytes ?? 0,
    totalBytes: largeText?.totalBytes ?? 0,
    offset: largeText?.loadedBytes ?? 0,
    appendedText: '',
    loading: false,
    failed: false,
  }));
  const activeState = useMemo(() => (
    largeText
      && state.contentRef === largeText.contentRef
      && state.loadedBytes === largeText.loadedBytes
      && state.totalBytes === largeText.totalBytes
      ? state
      : {
        contentRef: largeText?.contentRef ?? null,
        loadedBytes: largeText?.loadedBytes ?? 0,
        totalBytes: largeText?.totalBytes ?? 0,
        offset: largeText?.loadedBytes ?? 0,
        appendedText: '',
        loading: false,
        failed: false,
      }
  ), [largeText, state]);
  const complete = !largeText || activeState.offset >= largeText.totalBytes;

  const loadMore = useCallback(() => {
    if (!largeText || !sessionIdentity || activeState.loading || complete) {
      return;
    }
    const offset = activeState.offset;
    setState({ ...activeState, loading: true, failed: false });
    void hostSessionContentLoad({
      sessionIdentity,
      ...(endpointSessionId ? { endpointSessionId } : {}),
      contentRef: largeText.contentRef,
      offset,
      limit: LARGE_TEXT_CHUNK_LIMIT,
    }).then((chunk) => {
      setState((current) => {
        if (current.contentRef !== largeText.contentRef || current.offset !== offset) {
          return current;
        }
        if (chunk.contentRef !== largeText.contentRef || chunk.offset !== offset || chunk.nextOffset < offset) {
          return { ...current, loading: false, failed: true };
        }
        const nextOffset = Math.min(chunk.nextOffset, chunk.totalBytes);
        return {
          contentRef: largeText.contentRef,
          loadedBytes: largeText.loadedBytes,
          totalBytes: largeText.totalBytes,
          offset: nextOffset,
          appendedText: `${current.appendedText}${chunk.text}`,
          loading: false,
          failed: false,
        };
      });
    }).catch(() => {
      setState((current) => (
        current.contentRef === largeText.contentRef && current.offset === offset
          ? { ...current, loading: false, failed: true }
          : current
      ));
    });
  }, [activeState, complete, endpointSessionId, largeText, sessionIdentity]);

  return {
    text: `${initialText}${activeState.appendedText}`,
    loadMoreButton: largeText && !complete && sessionIdentity ? (
      <div className="mt-2 flex items-center gap-2">
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="h-7 px-2 text-[12px]"
          disabled={activeState.loading}
          onClick={loadMore}
        >
          {activeState.loading ? '加载中…' : '加载更多'}
        </Button>
        {activeState.failed ? <span className="text-[12px] text-muted-foreground">加载失败</span> : null}
      </div>
    ) : null,
  };
}
