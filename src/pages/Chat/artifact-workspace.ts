import type { ArtifactPreviewTarget } from '@/components/file-preview/types';
import type { GeneratedFile } from '@/lib/generated-files';

interface ResolveArtifactWorkspaceRootInput {
  currentWorkspace?: string | null;
  artifactFiles: GeneratedFile[];
  artifactFocusedFile: ArtifactPreviewTarget | null;
}

function isWorkspaceLikeContentType(contentType: string | undefined): boolean {
  return contentType === 'code' || contentType === 'text' || contentType === 'markdown';
}

export function resolveArtifactWorkspaceRoot(input: ResolveArtifactWorkspaceRootInput): string | null {
  const workspace = input.currentWorkspace?.trim();
  if (workspace) {
    return workspace;
  }

  const workspaceSeedPath = input.artifactFiles.find((file) => (
    file.sourceTool === 'edit'
    || (file.action === 'modified' && isWorkspaceLikeContentType(file.contentType))
  ))?.filePath
    ?? input.artifactFiles.find((file) => isWorkspaceLikeContentType(file.contentType))?.filePath
    ?? input.artifactFocusedFile?.filePath
    ?? input.artifactFiles[0]?.filePath
    ?? '';

  if (!workspaceSeedPath) {
    return null;
  }

  const normalized = workspaceSeedPath.replace(/\\/g, '/');
  const slashIndex = normalized.lastIndexOf('/');
  if (slashIndex <= 0) {
    return null;
  }
  return workspaceSeedPath.slice(0, slashIndex);
}
