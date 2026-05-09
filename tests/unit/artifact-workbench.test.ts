import { describe, expect, it } from 'vitest';
import type { ArtifactPreviewTarget } from '@/components/file-preview/types';
import {
  collectArtifactGroupPaths,
  collectArtifactGroupTargets,
  resolveArtifactGroupFocusFile,
  resolveArtifactGroupKeyForFile,
  resolvePreviewableArtifactGroupTarget,
  resolveArtifactWorkbenchSelection,
} from '@/pages/Chat/artifact-workbench';
import type { ChatArtifactGroup } from '@/pages/Chat/artifacts';

function makeGroup(graphItemKey: string, filePaths: string[]): ChatArtifactGroup {
  return {
    graphItemKey,
    files: filePaths.map((filePath, index) => ({
      filePath,
      fileName: filePath.split('/').pop() || filePath,
      ext: filePath.endsWith('.ts') ? '.ts' : '.md',
      mimeType: filePath.endsWith('.ts') ? 'text/typescript' : 'text/markdown',
      contentType: filePath.endsWith('.ts') ? 'code' : 'markdown',
      sourceTool: 'edit',
      action: index === 0 ? 'modified' : 'created',
      baseline: 'before\n',
      content: 'after\n',
      lineStats: { added: 1, removed: 1 },
      toolId: `${graphItemKey}-${index}`,
    })),
  };
}

function makeTarget(filePath: string, options?: Partial<ArtifactPreviewTarget>): ArtifactPreviewTarget {
  return {
    filePath,
    fileName: filePath.split('/').pop() || filePath,
    ext: filePath.endsWith('.md') ? '.md' : '.ts',
    mimeType: filePath.endsWith('.md') ? 'text/markdown' : 'text/typescript',
    contentType: filePath.endsWith('.md') ? 'markdown' : 'code',
    ...options,
  };
}

describe('artifact workbench helpers', () => {
  it('resolves the focused group from the focused file path', () => {
    const groups = [
      makeGroup('graph-1', ['/workspace/demo.ts']),
      makeGroup('graph-2', ['/workspace/notes.md']),
    ];

    const selection = resolveArtifactWorkbenchSelection({
      artifactGroups: groups,
      focusedGroupKey: null,
      focusedFilePath: '/workspace/notes.md',
      focusedFileOverride: null,
    });

    expect(selection.focusedGroupKey).toBe('graph-2');
    expect(selection.focusedGroupIndex).toBe(1);
    expect(selection.focusedGroupFiles.map((file) => file.filePath)).toEqual(['/workspace/notes.md']);
    expect(selection.focusedGeneratedFile?.filePath).toBe('/workspace/notes.md');
    expect(selection.focusedFile?.filePath).toBe('/workspace/notes.md');
  });

  it('keeps a directory override when the focused file is outside generated files', () => {
    const groups = [makeGroup('graph-1', ['/workspace/demo.ts'])];
    const directory = makeTarget('/workspace/generated', {
      fileName: 'generated',
      mimeType: 'application/x-directory',
      contentType: 'binary',
      isDirectory: true,
    });

    const selection = resolveArtifactWorkbenchSelection({
      artifactGroups: groups,
      focusedGroupKey: 'graph-1',
      focusedFilePath: '/workspace/generated',
      focusedFileOverride: directory,
    });

    expect(selection.focusedGroupKey).toBe('graph-1');
    expect(selection.focusedGeneratedFile).toBeNull();
    expect(selection.focusedFile).toEqual(directory);
  });

  it('falls back to the latest file in a group when no preferred file matches', () => {
    const group = makeGroup('graph-1', ['/workspace/demo.ts', '/workspace/notes.md']);
    expect(resolveArtifactGroupFocusFile(group, '/workspace/missing.ts')?.filePath).toBe('/workspace/notes.md');
  });

  it('collects group targets and paths in stable file order', () => {
    const group = makeGroup('graph-1', ['/workspace/demo.ts', '/workspace/notes.md']);
    expect(collectArtifactGroupTargets(group).map((target) => target.filePath)).toEqual([
      '/workspace/demo.ts',
      '/workspace/notes.md',
    ]);
    expect(collectArtifactGroupPaths(group)).toEqual([
      '/workspace/demo.ts',
      '/workspace/notes.md',
    ]);
  });

  it('resolves the previewable target for a group from the preferred file path first', () => {
    const group = makeGroup('graph-1', ['/workspace/demo.ts', '/workspace/notes.md']);
    expect(resolvePreviewableArtifactGroupTarget(group, '/workspace/demo.ts')?.filePath).toBe('/workspace/demo.ts');
    expect(resolvePreviewableArtifactGroupTarget(group, '/workspace/missing.ts')?.filePath).toBe('/workspace/notes.md');
  });

  it('resolves the owning group key for a file path', () => {
    const groups = [
      makeGroup('graph-1', ['/workspace/demo.ts']),
      makeGroup('graph-2', ['/workspace/notes.md']),
    ];
    expect(resolveArtifactGroupKeyForFile(groups, '/workspace/demo.ts')).toBe('graph-1');
    expect(resolveArtifactGroupKeyForFile(groups, '/workspace/missing.ts')).toBeNull();
  });
});
