import type { ArtifactPreviewTarget } from '@/components/file-preview/types';
import { buildArtifactPreviewTargetFromGeneratedFile } from '@/components/file-preview/types';
import type { GeneratedFile } from '@/lib/generated-files';
import type { ChatArtifactGroup } from './artifacts';

export interface ResolveArtifactWorkbenchSelectionInput {
  artifactGroups: ChatArtifactGroup[];
  focusedGroupKey: string | null;
  focusedFilePath: string | null;
  focusedFileOverride: ArtifactPreviewTarget | null;
}

export interface ArtifactWorkbenchSelection {
  focusedGroupKey: string | null;
  focusedGroupIndex: number;
  focusedGroup: ChatArtifactGroup | null;
  focusedGroupFiles: GeneratedFile[];
  focusedGeneratedFile: GeneratedFile | null;
  focusedFile: ArtifactPreviewTarget | null;
}

function dedupeByFilePath(targets: ReadonlyArray<ArtifactPreviewTarget>): ArtifactPreviewTarget[] {
  const uniqueTargets = new Map<string, ArtifactPreviewTarget>();
  for (const target of targets) {
    if (!target.filePath) {
      continue;
    }
    uniqueTargets.set(target.filePath, target);
  }
  return [...uniqueTargets.values()];
}

export function resolveArtifactGroupKeyForFile(
  artifactGroups: ReadonlyArray<ChatArtifactGroup>,
  filePath: string | null | undefined,
): string | null {
  if (!filePath) {
    return null;
  }
  const matchedGroup = artifactGroups.find((group) => group.files.some((file) => file.filePath === filePath));
  return matchedGroup?.graphItemKey ?? null;
}

export function resolveArtifactGroupFocusFile(
  artifactGroup: ChatArtifactGroup | null | undefined,
  preferredFilePath?: string | null,
): GeneratedFile | null {
  if (!artifactGroup || artifactGroup.files.length === 0) {
    return null;
  }
  if (preferredFilePath) {
    const matchedFile = artifactGroup.files.find((file) => file.filePath === preferredFilePath);
    if (matchedFile) {
      return matchedFile;
    }
  }
  return artifactGroup.files[artifactGroup.files.length - 1] ?? null;
}

export function collectArtifactGroupTargets(
  artifactGroup: ChatArtifactGroup | null | undefined,
): ArtifactPreviewTarget[] {
  if (!artifactGroup) {
    return [];
  }
  return dedupeByFilePath(artifactGroup.files.map((file) => buildArtifactPreviewTargetFromGeneratedFile(file)));
}

export function collectArtifactGroupPaths(
  artifactGroup: ChatArtifactGroup | null | undefined,
): string[] {
  return collectArtifactGroupTargets(artifactGroup).map((target) => target.filePath);
}

export function resolvePreviewableArtifactGroupTarget(
  artifactGroup: ChatArtifactGroup | null | undefined,
  preferredFilePath?: string | null,
): ArtifactPreviewTarget | null {
  const focusFile = resolveArtifactGroupFocusFile(artifactGroup, preferredFilePath);
  if (focusFile) {
    return buildArtifactPreviewTargetFromGeneratedFile(focusFile);
  }
  return collectArtifactGroupTargets(artifactGroup).find((target) => !target.isDirectory) ?? null;
}

export function resolveArtifactWorkbenchSelection(
  input: ResolveArtifactWorkbenchSelectionInput,
): ArtifactWorkbenchSelection {
  const groupKey = input.focusedGroupKey
    && input.artifactGroups.some((group) => group.graphItemKey === input.focusedGroupKey)
    ? input.focusedGroupKey
    : (
        resolveArtifactGroupKeyForFile(input.artifactGroups, input.focusedFilePath)
        ?? input.artifactGroups[0]?.graphItemKey
        ?? null
      );
  const focusedGroupIndex = groupKey
    ? input.artifactGroups.findIndex((group) => group.graphItemKey === groupKey)
    : -1;
  const focusedGroup = focusedGroupIndex >= 0
    ? input.artifactGroups[focusedGroupIndex] ?? null
    : null;
  const focusedGroupFiles = focusedGroup?.files ?? [];
  const focusedGeneratedFile = input.focusedFilePath
    ? focusedGroupFiles.find((file) => file.filePath === input.focusedFilePath) ?? null
    : null;
  const focusedFile = focusedGeneratedFile
    ? buildArtifactPreviewTargetFromGeneratedFile(focusedGeneratedFile)
    : (
        input.focusedFileOverride
        && input.focusedFileOverride.filePath === input.focusedFilePath
          ? input.focusedFileOverride
          : input.focusedFileOverride
      );

  return {
    focusedGroupKey: groupKey,
    focusedGroupIndex,
    focusedGroup,
    focusedGroupFiles,
    focusedGeneratedFile,
    focusedFile,
  };
}
