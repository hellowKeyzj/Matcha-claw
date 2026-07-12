import { useCallback, useEffect, useRef, useState } from 'react';
import { FitAddon } from '@xterm/addon-fit';
import { Terminal } from '@xterm/xterm';
import { resolveHostApiBase } from '@/lib/host-api';
import type { RemoteFleetTerminalConnection, RemoteFleetTerminalOpenResult, RemoteFleetTerminalSessionSummary } from '@/stores/remote-fleet';
import type {
  RemoteFleetTerminalConnectionRequest,
  RemoteFleetTerminalControlFrame,
  RemoteFleetTerminalStatusSnapshot,
} from './remote-fleet-terminal-types';

const DEFAULT_TERMINAL_ROWS = 24;
const DEFAULT_TERMINAL_COLS = 80;
const SOCKET_CONNECTING_STATE = 0;
const SOCKET_OPEN_STATE = 1;

interface UseRemoteFleetTerminalOptions {
  readonly openTerminal: (request: RemoteFleetTerminalConnectionRequest) => Promise<RemoteFleetTerminalOpenResult>;
  readonly reconnectTerminal: (sessionId: string) => Promise<RemoteFleetTerminalOpenResult>;
  readonly closeTerminal: (sessionId: string, reason?: string) => Promise<void>;
}

interface UseRemoteFleetTerminalResult {
  readonly containerRef: (element: HTMLDivElement | null) => void;
  readonly snapshot: RemoteFleetTerminalStatusSnapshot;
  readonly connect: (request: RemoteFleetTerminalConnectionRequest) => Promise<void>;
  readonly reconnect: () => Promise<void>;
  readonly close: (reason?: string) => Promise<void>;
}

async function buildTerminalWebSocketUrl(websocketPath: string): Promise<string> {
  const baseUrl = new URL(await resolveHostApiBase());
  baseUrl.protocol = baseUrl.protocol === 'https:' ? 'wss:' : 'ws:';
  return new URL(websocketPath, baseUrl).toString();
}

function createTerminal(): { terminal: Terminal; fitAddon: FitAddon } {
  const terminal = new Terminal({
    cursorBlink: true,
    convertEol: true,
    fontFamily: 'Menlo, Monaco, Consolas, "Liberation Mono", monospace',
    fontSize: 13,
    rows: DEFAULT_TERMINAL_ROWS,
    cols: DEFAULT_TERMINAL_COLS,
    theme: {
      background: '#0f172a',
      foreground: '#e2e8f0',
      cursor: '#f8fafc',
      selectionBackground: '#334155',
    },
  });
  const fitAddon = new FitAddon();
  terminal.loadAddon(fitAddon);
  return { terminal, fitAddon };
}

function encodeTerminalInput(data: string): Uint8Array {
  return new TextEncoder().encode(data);
}

function isTerminalControlFrame(value: unknown): value is RemoteFleetTerminalControlFrame {
  return Boolean(value) && typeof value === 'object' && typeof (value as { type?: unknown }).type === 'string';
}

async function parseTextFrame(data: unknown): Promise<RemoteFleetTerminalControlFrame | null> {
  const text = typeof data === 'string'
    ? data
    : data instanceof Blob
      ? await data.text()
      : data instanceof ArrayBuffer
        ? new TextDecoder().decode(data)
        : ArrayBuffer.isView(data)
          ? new TextDecoder().decode(data)
          : '';
  if (!text) return null;
  try {
    const parsed = JSON.parse(text) as unknown;
    return isTerminalControlFrame(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function sendControlFrame(ws: WebSocket | null, frame: RemoteFleetTerminalControlFrame): void {
  if (!ws || ws.readyState !== SOCKET_OPEN_STATE) return;
  ws.send(JSON.stringify(frame));
}

function terminalSize(terminal: Terminal) {
  return {
    cols: terminal.cols || DEFAULT_TERMINAL_COLS,
    rows: terminal.rows || DEFAULT_TERMINAL_ROWS,
  };
}

function isReusableTerminalConnection(socket: WebSocket | null): socket is WebSocket {
  return socket?.readyState === SOCKET_OPEN_STATE || socket?.readyState === SOCKET_CONNECTING_STATE;
}

function terminalRequestTargetKey(request: RemoteFleetTerminalConnectionRequest): string {
  return `${request.target.kind}:${request.target.id}`;
}

function attachTerminalToContainer(terminal: Terminal, container: HTMLDivElement): void {
  if (terminal.element) {
    if (terminal.element.parentElement !== container) {
      container.replaceChildren(terminal.element);
    }
    return;
  }

  terminal.open(container);
}

export function useRemoteFleetTerminal({ openTerminal, reconnectTerminal, closeTerminal }: UseRemoteFleetTerminalOptions): UseRemoteFleetTerminalResult {
  const containerElementRef = useRef<HTMLDivElement | null>(null);
  const terminalRef = useRef<Terminal | null>(null);
  const fitAddonRef = useRef<FitAddon | null>(null);
  const socketRef = useRef<WebSocket | null>(null);
  const resizeObserverRef = useRef<ResizeObserver | null>(null);
  const currentConnectionRef = useRef<RemoteFleetTerminalConnection | null>(null);
  const currentSessionRef = useRef<RemoteFleetTerminalSessionSummary | null>(null);
  const currentTargetKeyRef = useRef<string | null>(null);
  const [snapshot, setSnapshot] = useState<RemoteFleetTerminalStatusSnapshot>({ status: 'idle' });

  const fitTerminalToContainer = useCallback(() => {
    if (!terminalRef.current) return;
    fitAddonRef.current?.fit();
  }, []);

  const syncTerminalSize = useCallback((socket: WebSocket | null = socketRef.current) => {
    const terminal = terminalRef.current;
    if (!terminal) return;
    fitTerminalToContainer();
    sendControlFrame(socket, { type: 'terminal.resize', ...terminalSize(terminal) });
  }, [fitTerminalToContainer]);

  const disconnectResizeObserver = useCallback(() => {
    resizeObserverRef.current?.disconnect();
    resizeObserverRef.current = null;
  }, []);

  const observeTerminalContainer = useCallback((element: HTMLDivElement | null) => {
    disconnectResizeObserver();
    if (!element || typeof ResizeObserver === 'undefined') return;
    const resizeObserver = new ResizeObserver(() => syncTerminalSize());
    resizeObserver.observe(element);
    resizeObserverRef.current = resizeObserver;
  }, [disconnectResizeObserver, syncTerminalSize]);

  const disposeSocket = useCallback(() => {
    const socket = socketRef.current;
    socketRef.current = null;
    if (isReusableTerminalConnection(socket)) {
      socket.close(1000, 'terminal closed');
    }
  }, []);

  const disposeTerminal = useCallback(() => {
    disconnectResizeObserver();
    terminalRef.current?.dispose();
    fitAddonRef.current?.dispose();
    terminalRef.current = null;
    fitAddonRef.current = null;
  }, [disconnectResizeObserver]);

  const ensureTerminal = useCallback(() => {
    if (!terminalRef.current) {
      const { terminal, fitAddon } = createTerminal();
      terminal.onData((data) => {
        const socket = socketRef.current;
        if (socket?.readyState === SOCKET_OPEN_STATE) {
          socket.send(encodeTerminalInput(data));
        }
      });
      terminalRef.current = terminal;
      fitAddonRef.current = fitAddon;
    }

    if (containerElementRef.current) {
      attachTerminalToContainer(terminalRef.current, containerElementRef.current);
      syncTerminalSize();
    }

    return terminalRef.current;
  }, [syncTerminalSize]);

  const attachSocket = useCallback(async (connection: RemoteFleetTerminalConnection) => {
    disposeSocket();
    currentConnectionRef.current = connection;
    const terminal = ensureTerminal();
    const socket = new WebSocket(await buildTerminalWebSocketUrl(connection.websocketPath));
    socket.binaryType = 'arraybuffer';
    socketRef.current = socket;
    setSnapshot((current) => ({ ...current, status: 'connecting', errorKind: undefined }));
    terminal.focus();

    socket.addEventListener('open', () => {
      syncTerminalSize(socket);
    });

    socket.addEventListener('message', (event) => {
      if (typeof event.data === 'string') {
        void parseTextFrame(event.data).then((frame) => {
          if (!frame) return;
          if (frame.type === 'terminal.ready') {
            setSnapshot((current) => ({ ...current, status: 'ready', errorKind: undefined }));
            return;
          }
          if (frame.type === 'terminal.error') {
            setSnapshot((current) => ({ ...current, status: 'error', errorKind: 'remote-error' }));
            return;
          }
          if (frame.type === 'terminal.exit') {
            setSnapshot((current) => ({
              ...current,
              status: 'exited',
              exitCode: frame.exitCode,
              signal: frame.signal,
            }));
            return;
          }
        });
        return;
      }

      if (event.data instanceof ArrayBuffer) {
        terminal.write(new Uint8Array(event.data));
        return;
      }

      if (event.data instanceof Blob) {
        void event.data.arrayBuffer().then((buffer) => terminal.write(new Uint8Array(buffer)));
      }
    });

    socket.addEventListener('error', () => {
      setSnapshot((current) => ({ ...current, status: 'error', errorKind: 'connection-failed' }));
    });

    socket.addEventListener('close', () => {
      setSnapshot((current) => current.status === 'exited' || current.status === 'error'
        ? current
        : { ...current, status: 'closed' });
    });
  }, [disposeSocket, ensureTerminal, syncTerminalSize]);

  const connect = useCallback(async (request: RemoteFleetTerminalConnectionRequest) => {
    const targetKey = terminalRequestTargetKey(request);
    const terminal = ensureTerminal();
    if (currentTargetKeyRef.current === targetKey && currentSessionRef.current && isReusableTerminalConnection(socketRef.current)) {
      setSnapshot((current) => ({
        ...current,
        status: current.status === 'idle' || current.status === 'closed' ? 'ready' : current.status,
        session: currentSessionRef.current ?? current.session,
        errorKind: undefined,
      }));
      terminal.focus();
      syncTerminalSize();
      return;
    }

    const previousSessionId = currentConnectionRef.current?.sessionId ?? currentSessionRef.current?.id;
    const shouldClosePreviousSession = Boolean(
      previousSessionId && currentTargetKeyRef.current && (
        currentTargetKeyRef.current !== targetKey || !isReusableTerminalConnection(socketRef.current)
      ),
    );
    if (previousSessionId && shouldClosePreviousSession) {
      sendControlFrame(socketRef.current, { type: 'terminal.close', reason: 'terminal replaced' });
      disposeSocket();
      await closeTerminal(previousSessionId, 'terminal replaced').catch(() => undefined);
    }

    currentConnectionRef.current = null;
    currentSessionRef.current = null;
    currentTargetKeyRef.current = targetKey;
    setSnapshot({ status: 'opening' });
    terminal.clear();
    const size = request.size ?? terminalSize(terminal);
    try {
      const result = await openTerminal({ ...request, size });
      currentSessionRef.current = result.session;
      setSnapshot({ status: 'connecting', session: result.session });
      await attachSocket(result.terminalConnection);
    } catch {
      currentTargetKeyRef.current = null;
      setSnapshot({ status: 'error', errorKind: 'open-failed' });
    }
  }, [attachSocket, closeTerminal, disposeSocket, ensureTerminal, openTerminal, syncTerminalSize]);

  const reconnect = useCallback(async () => {
    const sessionId = currentConnectionRef.current?.sessionId ?? currentSessionRef.current?.id;
    if (!sessionId) return;
    setSnapshot((current) => ({ ...current, status: 'opening', errorKind: undefined }));
    try {
      const result = await reconnectTerminal(sessionId);
      currentSessionRef.current = result.session;
      setSnapshot({ status: 'connecting', session: result.session });
      await attachSocket(result.terminalConnection);
    } catch {
      setSnapshot((current) => ({ ...current, status: 'error', errorKind: 'reconnect-failed' }));
    }
  }, [attachSocket, reconnectTerminal]);

  const close = useCallback(async (reason?: string) => {
    const sessionId = currentConnectionRef.current?.sessionId ?? currentSessionRef.current?.id;
    sendControlFrame(socketRef.current, { type: 'terminal.close', ...(reason ? { reason } : {}) });
    disposeSocket();
    disposeTerminal();
    currentConnectionRef.current = null;
    currentSessionRef.current = null;
    currentTargetKeyRef.current = null;
    if (sessionId) {
      await closeTerminal(sessionId, reason);
    }
    setSnapshot((current) => ({ ...current, status: 'closed' }));
  }, [disposeSocket, disposeTerminal, closeTerminal]);

  const containerRef = useCallback((element: HTMLDivElement | null) => {
    containerElementRef.current = element;
    observeTerminalContainer(element);
    if (element) {
      ensureTerminal();
    }
  }, [ensureTerminal, observeTerminalContainer]);

  useEffect(() => {
    return () => {
      const sessionId = currentConnectionRef.current?.sessionId ?? currentSessionRef.current?.id;
      sendControlFrame(socketRef.current, { type: 'terminal.close', reason: 'drawer unmounted' });
      disposeSocket();
      disposeTerminal();
      if (sessionId) {
        void closeTerminal(sessionId, 'drawer unmounted').catch(() => undefined);
      }
      currentConnectionRef.current = null;
      currentSessionRef.current = null;
      currentTargetKeyRef.current = null;
    };
  }, [disposeSocket, disposeTerminal, closeTerminal]);

  return {
    containerRef,
    snapshot,
    connect,
    reconnect,
    close,
  };
}
