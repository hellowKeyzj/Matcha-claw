import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { Sidebar } from '@/components/layout/Sidebar';
import { useChatStore } from '@/stores/chat';
import { useSettingsStore } from '@/stores/settings';

describe('sidebar chat nav behavior', () => {
  beforeEach(() => {
    useSettingsStore.setState({
      ...useSettingsStore.getState(),
      sidebarCollapsed: false,
      devModeUnlocked: false,
    }, true);
    useChatStore.setState(useChatStore.getInitialState(), true);
  });

  it('从非聊天路由进入聊天页时不自动创建新会话', () => {
    const newSession = vi.fn();
    useChatStore.setState({
      ...useChatStore.getState(),
      messages: [{ role: 'user', content: 'hello', timestamp: Date.now() }],
      newSession: newSession as never,
    }, true);

    render(
      <MemoryRouter initialEntries={['/settings']}>
        <Sidebar />
      </MemoryRouter>,
    );

    fireEvent.click(screen.getByRole('button', { name: /new chat|会话/i }));
    expect(newSession).not.toHaveBeenCalled();
  });

  it('在聊天路由点击会话按钮时会创建新会话', () => {
    const newSession = vi.fn();
    useChatStore.setState({
      ...useChatStore.getState(),
      messages: [{ role: 'user', content: 'hello', timestamp: Date.now() }],
      newSession: newSession as never,
    }, true);

    render(
      <MemoryRouter initialEntries={['/']}>
        <Sidebar />
      </MemoryRouter>,
    );

    fireEvent.click(screen.getByRole('button', { name: /new chat|会话/i }));
    expect(newSession).toHaveBeenCalledTimes(1);
  });
});
