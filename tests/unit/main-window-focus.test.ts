import { describe, expect, it } from 'vitest';
import {
  consumeMainWindowReady,
  createMainWindowFocusState,
  requestSecondInstanceFocus,
} from '../../electron/main/main-window-focus';

describe('main window focus coordination', () => {
  it('主窗口未就绪时会延迟 second-instance 焦点请求', () => {
    const state = createMainWindowFocusState();
    expect(requestSecondInstanceFocus(state, false)).toBe('defer');
    expect(state.pendingSecondInstanceFocus).toBe(true);
    expect(consumeMainWindowReady(state)).toBe('focus');
    expect(state.pendingSecondInstanceFocus).toBe(false);
  });

  it('没有 pending 请求时主窗口按 show 处理', () => {
    const state = createMainWindowFocusState();
    expect(consumeMainWindowReady(state)).toBe('show');
    expect(state.pendingSecondInstanceFocus).toBe(false);
  });

  it('已有可聚焦主窗口时 second-instance 直接 focus-now', () => {
    const state = createMainWindowFocusState();
    requestSecondInstanceFocus(state, false);
    expect(requestSecondInstanceFocus(state, true)).toBe('focus-now');
    expect(state.pendingSecondInstanceFocus).toBe(false);
  });
});
