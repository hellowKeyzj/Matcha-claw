import { create } from 'zustand';
import { CHAT_WORKSPACE_LAYOUT, clampPaneWidth, getSidebarResizeMaxWidth } from '@/pages/Chat/chat-workspace-layout';

interface LayoutState {
  sidebarVisible: boolean;
  sidebarWidth: number;
  setSidebarVisible: (value: boolean) => void;
  toggleSidebar: () => void;
  setSidebarWidth: (value: number, containerWidth: number) => void;
}

const SIDEBAR_VISIBLE_STORAGE_KEY = 'layout:sidebar-visible';
const SIDEBAR_WIDTH_STORAGE_KEY = 'layout:sidebar-width';

function readStoredSidebarVisible(): boolean {
  if (typeof window === 'undefined') {
    return true;
  }
  try {
    const raw = window.localStorage.getItem(SIDEBAR_VISIBLE_STORAGE_KEY);
    if (raw == null) {
      return true;
    }
    return raw !== '0';
  } catch {
    return true;
  }
}

function readStoredSidebarWidth(): number {
  if (typeof window === 'undefined') {
    return CHAT_WORKSPACE_LAYOUT.sidebarDefaultWidth;
  }
  try {
    const raw = Number(window.localStorage.getItem(SIDEBAR_WIDTH_STORAGE_KEY) || CHAT_WORKSPACE_LAYOUT.sidebarDefaultWidth);
    if (!Number.isFinite(raw)) {
      return CHAT_WORKSPACE_LAYOUT.sidebarDefaultWidth;
    }
    return clampPaneWidth(raw, CHAT_WORKSPACE_LAYOUT.sidebarMinWidth, CHAT_WORKSPACE_LAYOUT.sidebarMaxWidth);
  } catch {
    return CHAT_WORKSPACE_LAYOUT.sidebarDefaultWidth;
  }
}

function persistSidebarVisible(value: boolean) {
  if (typeof window === 'undefined') {
    return;
  }
  try {
    window.localStorage.setItem(SIDEBAR_VISIBLE_STORAGE_KEY, value ? '1' : '0');
  } catch {
    // ignore localStorage failures
  }
}

function persistSidebarWidth(value: number) {
  if (typeof window === 'undefined') {
    return;
  }
  try {
    window.localStorage.setItem(SIDEBAR_WIDTH_STORAGE_KEY, String(value));
  } catch {
    // ignore localStorage failures
  }
}

export const useLayoutStore = create<LayoutState>((set) => ({
  sidebarVisible: readStoredSidebarVisible(),
  sidebarWidth: readStoredSidebarWidth(),
  setSidebarVisible: (sidebarVisible) => {
    persistSidebarVisible(sidebarVisible);
    set({ sidebarVisible });
  },
  toggleSidebar: () => {
    set((state) => {
      const sidebarVisible = !state.sidebarVisible;
      persistSidebarVisible(sidebarVisible);
      return { sidebarVisible };
    });
  },
  setSidebarWidth: (value, containerWidth) => {
    const sidebarWidth = clampPaneWidth(
      value,
      CHAT_WORKSPACE_LAYOUT.sidebarMinWidth,
      getSidebarResizeMaxWidth(containerWidth),
    );
    persistSidebarWidth(sidebarWidth);
    set({ sidebarWidth });
  },
}));
