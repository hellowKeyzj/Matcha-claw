import { act, renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useChatWindowDockController } from '@/pages/Chat/useChatWindowDockController';
import { useLayoutStore } from '@/stores/layout';

const invokeIpcMock = vi.hoisted(() => vi.fn());

vi.mock('@/lib/api-client', () => ({
  invokeIpc: (...args: unknown[]) => invokeIpcMock(...args),
}));

function setWindowInnerWidth(width: number): void {
  Object.defineProperty(window, 'innerWidth', {
    configurable: true,
    value: width,
  });
}

function createChatLayoutRef(stageWidth = 1200): { current: HTMLDivElement } {
  const layoutNode = document.createElement('div');
  const stageNode = document.createElement('div');
  layoutNode.appendChild(stageNode);
  layoutNode.getBoundingClientRect = () => DOMRect.fromRect({ width: window.innerWidth, height: 800 });
  stageNode.getBoundingClientRect = () => DOMRect.fromRect({ width: stageWidth, height: 800 });
  return { current: layoutNode };
}

function renderController(options: { setPanelWidth?: (width: number) => void } = {}) {
  return renderHook(({ panelOpen }: { panelOpen: boolean }) => useChatWindowDockController({
    enabled: true,
    panelOpen,
    preferredWidth: 520,
    renderWidth: 520,
    widthPolicy: 'artifacts',
    artifactWorkbenchFullscreen: false,
    chatLayoutRef: createChatLayoutRef(),
    openPanel: vi.fn(),
    closePanel: vi.fn(),
    setPanelWidth: options.setPanelWidth ?? vi.fn(),
  }), { initialProps: { panelOpen: false } });
}

describe('chat window dock controller', () => {
  beforeEach(() => {
    invokeIpcMock.mockReset();
    setWindowInnerWidth(1200);
    useLayoutStore.setState({
      chatTakeoverMode: 'none',
      chatWindowRightDockLayout: null,
    });
  });

  it('publishes the opening dock reservation before waiting for Electron resize', async () => {
    invokeIpcMock.mockReturnValue(new Promise(() => undefined));

    const { result, rerender } = renderController();

    rerender({ panelOpen: true });

    await waitFor(() => {
      expect(useLayoutStore.getState().chatWindowRightDockLayout).toEqual({
        phase: 'opening',
        dockWidth: 526,
        baseWidth: 1200,
      });
    });
    expect(result.current.phase).toBe('opening');
    expect(result.current.sidePanelMainWidth).toBe(1200);
    expect(invokeIpcMock).toHaveBeenCalledWith('window:setRightDockWidth', 526, { currentDockWidth: 0 });
  });

  it('keeps the main column locked while external window resizing expands the docked panel', async () => {
    invokeIpcMock.mockResolvedValue({ appliedWidth: 526 });
    const setPanelWidth = vi.fn();

    const { result, rerender } = renderController({ setPanelWidth });

    rerender({ panelOpen: true });
    setWindowInnerWidth(1726);
    window.dispatchEvent(new Event('resize'));

    await waitFor(() => {
      expect(result.current.phase).toBe('open');
    });

    act(() => {
      setWindowInnerWidth(1926);
      window.dispatchEvent(new Event('resize'));
    });

    await waitFor(() => {
      expect(result.current.sidePanelMainWidth).toBe(1200);
      expect(result.current.sidePanelWidth).toBe(720);
      expect(useLayoutStore.getState().chatWindowRightDockLayout).toEqual({
        phase: 'open',
        dockWidth: 726,
        baseWidth: 1200,
      });
    });
    expect(setPanelWidth).not.toHaveBeenCalled();
  });

  it('shrinks the docked panel before shrinking the main column on external window narrowing', async () => {
    invokeIpcMock.mockResolvedValue({ appliedWidth: 526 });

    const { result, rerender } = renderController();

    rerender({ panelOpen: true });
    setWindowInnerWidth(1726);
    window.dispatchEvent(new Event('resize'));

    await waitFor(() => {
      expect(result.current.phase).toBe('open');
    });

    act(() => {
      setWindowInnerWidth(1526);
      window.dispatchEvent(new Event('resize'));
    });

    await waitFor(() => {
      expect(result.current.sidePanelMainWidth).toBe(1200);
      expect(result.current.sidePanelWidth).toBe(320);
      expect(useLayoutStore.getState().chatWindowRightDockLayout).toEqual({
        phase: 'open',
        dockWidth: 326,
        baseWidth: 1200,
      });
    });

    act(() => {
      setWindowInnerWidth(1400);
      window.dispatchEvent(new Event('resize'));
    });

    await waitFor(() => {
      expect(result.current.sidePanelMainWidth).toBe(1134);
      expect(result.current.sidePanelWidth).toBe(260);
      expect(useLayoutStore.getState().chatWindowRightDockLayout).toEqual({
        phase: 'open',
        dockWidth: 266,
        baseWidth: 1134,
      });
    });

    act(() => {
      setWindowInnerWidth(1726);
      window.dispatchEvent(new Event('resize'));
    });

    await waitFor(() => {
      expect(result.current.sidePanelMainWidth).toBe(1200);
      expect(result.current.sidePanelWidth).toBe(520);
      expect(useLayoutStore.getState().chatWindowRightDockLayout).toEqual({
        phase: 'open',
        dockWidth: 526,
        baseWidth: 1200,
      });
    });
  });

  it('closes after external window resizing expands the docked panel', async () => {
    invokeIpcMock.mockResolvedValue({ appliedWidth: 526 });

    const { result, rerender } = renderController();

    rerender({ panelOpen: true });
    setWindowInnerWidth(1726);
    window.dispatchEvent(new Event('resize'));

    await waitFor(() => {
      expect(result.current.phase).toBe('open');
    });

    act(() => {
      setWindowInnerWidth(1926);
      window.dispatchEvent(new Event('resize'));
    });

    await waitFor(() => {
      expect(result.current.sidePanelWidth).toBe(720);
    });

    invokeIpcMock.mockResolvedValue({ appliedWidth: 0 });
    rerender({ panelOpen: false });
    act(() => {
      setWindowInnerWidth(1200);
      window.dispatchEvent(new Event('resize'));
    });

    await waitFor(() => {
      expect(result.current.phase).toBe('closed');
      expect(useLayoutStore.getState().chatWindowRightDockLayout).toBeNull();
    });
    expect(invokeIpcMock).toHaveBeenCalledWith('window:setRightDockWidth', 0, { currentDockWidth: 726 });
  });
});
