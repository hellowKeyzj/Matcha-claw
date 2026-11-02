import type { SessionIdentity } from '@/types/desktop/runtime-address';
import type { WorkspacePage } from './extensions';

export interface WorkspacePageRequest {
  readonly sessionIdentity: SessionIdentity;
  readonly page: WorkspacePage;
}

export const WORKSPACE_PAGE_OPEN_EVENT = 'workspace:open-page';

export function openWorkspacePage(request: WorkspacePageRequest): void {
  window.dispatchEvent(new CustomEvent(WORKSPACE_PAGE_OPEN_EVENT, { detail: request }));
}
