import type { SessionIdentity } from '@/types/desktop/runtime-address';
import type { WorkspacePage, WorkspaceSessionPromotion } from './extensions';

export interface WorkspacePageRequest {
  readonly sessionIdentity: SessionIdentity;
  readonly page: WorkspacePage;
}

export const WORKSPACE_PAGE_OPEN_EVENT = 'workspace:open-page';
export const WORKSPACE_CHAT_SHOW_EVENT = 'workspace:show-chat';
export const WORKSPACE_SESSION_PROMOTED_EVENT = 'workspace:session-promoted';

export function promoteWorkspaceSession(promotion: WorkspaceSessionPromotion): void {
  window.dispatchEvent(new CustomEvent(WORKSPACE_SESSION_PROMOTED_EVENT, { detail: promotion }));
}

export function showWorkspaceChat(): void {
  window.dispatchEvent(new Event(WORKSPACE_CHAT_SHOW_EVENT));
}

export function openWorkspacePage(request: WorkspacePageRequest): void {
  window.dispatchEvent(new CustomEvent(WORKSPACE_PAGE_OPEN_EVENT, { detail: request }));
}
