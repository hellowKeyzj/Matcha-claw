import { startTransition, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { ChevronDown, ChevronRight, FolderTree, GitCompare, RefreshCw } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/button';
import { LoadingSpinner } from '@/components/common/LoadingSpinner';
import { hostFileListDir, type FilePreviewDirEntry } from '@/lib/host-api';
import { classifyFileContentType, extnameOf, getMimeTypeForPath, supportsInlineDiff } from '@/lib/generated-files';
import { cn } from '@/lib/utils';
import { FilePreviewBody, type FilePreviewMode } from './FilePreviewBody';
import type { ArtifactPreviewTarget } from './types';
import type { RuntimeAddress } from '../../../runtime-host/shared/runtime-address';

interface WorkspaceBrowserBodyProps {
  rootPath: string | null;
  selectedFilePath: string | null;
  selectedFile: ArtifactPreviewTarget | null;
  runtimeAddress?: RuntimeAddress;
  availableWidth?: number;
  previewMode?: FilePreviewMode;
  onSelectFile: (file: ArtifactPreviewTarget) => void;
  onPreviewModeChange?: (mode: FilePreviewMode) => void;
  previewHeaderTrailingAccessory?: ReactNode;
  className?: string;
}

interface WorkspaceTreeNode extends FilePreviewDirEntry {
  children?: WorkspaceTreeNode[];
  childrenLoaded: boolean;
}

type TreeState =
  | { status: 'idle' }
  | { status: 'loading' }
  | { status: 'ready'; tree: WorkspaceTreeNode }
  | { status: 'error'; message: string };

const WORKSPACE_TREE_MIN_WIDTH = 220;
const WORKSPACE_TREE_DEFAULT_WIDTH = 280;
const WORKSPACE_SPLIT_MIN_WIDTH = 560;
const WORKSPACE_STACKED_TREE_HEIGHT = 320;
const WORKSPACE_DIR_LIST_TIMEOUT_MS = 60000;

function normalizeWorkspacePath(path: string): string {
  const normalized = path.replace(/\\/g, '/');
  if (/^[A-Za-z]:\/$/.test(normalized)) {
    return normalized;
  }
  if (normalized.length > 1) {
    return normalized.replace(/\/+$/, '');
  }
  return normalized;
}

function isSameWorkspacePath(left: string, right: string): boolean {
  return normalizeWorkspacePath(left) === normalizeWorkspacePath(right);
}

function getWorkspaceNodeName(path: string): string {
  const normalized = normalizeWorkspacePath(path);
  if (/^[A-Za-z]:\/$/.test(normalized)) {
    return normalized;
  }
  const segments = normalized.split('/').filter(Boolean);
  return segments.at(-1) ?? normalized;
}

function createWorkspaceTreeNode(entry: FilePreviewDirEntry): WorkspaceTreeNode {
  return {
    ...entry,
    hasChildren: entry.isDir ? entry.hasChildren !== false : false,
    childrenLoaded: !entry.isDir,
  };
}

function createWorkspaceRootNode(rootPath: string, entries: FilePreviewDirEntry[]): WorkspaceTreeNode {
  return {
    name: getWorkspaceNodeName(rootPath),
    path: rootPath,
    isDir: true,
    size: 0,
    mtimeMs: 0,
    hasChildren: entries.length > 0,
    childrenLoaded: true,
    children: entries.map(createWorkspaceTreeNode),
  };
}

function nodeCanExpand(node: WorkspaceTreeNode): boolean {
  if (!node.isDir) {
    return false;
  }
  if (!node.childrenLoaded) {
    return true;
  }
  return node.hasChildren === true;
}

function toPreviewFile(node: WorkspaceTreeNode): ArtifactPreviewTarget {
  const ext = extnameOf(node.path);
  const mimeType = getMimeTypeForPath(node.path);
  return {
    filePath: node.path,
    fileName: node.name,
    ext,
    mimeType,
    contentType: classifyFileContentType(ext, mimeType),
    fileSize: node.size > 0 ? node.size : undefined,
  };
}

function findTreeNode(root: WorkspaceTreeNode, targetPath: string): WorkspaceTreeNode | null {
  if (isSameWorkspacePath(root.path, targetPath)) {
    return root;
  }
  for (const child of root.children ?? []) {
    const matched = findTreeNode(child, targetPath);
    if (matched) {
      return matched;
    }
  }
  return null;
}

function replaceTreeNode(
  root: WorkspaceTreeNode,
  targetPath: string,
  update: (node: WorkspaceTreeNode) => WorkspaceTreeNode,
): WorkspaceTreeNode {
  if (isSameWorkspacePath(root.path, targetPath)) {
    return update(root);
  }
  if (!root.children?.length) {
    return root;
  }

  let changed = false;
  const nextChildren = root.children.map((child) => {
    const nextChild = replaceTreeNode(child, targetPath, update);
    if (nextChild !== child) {
      changed = true;
    }
    return nextChild;
  });

  return changed
    ? {
        ...root,
        children: nextChildren,
      }
    : root;
}

function mergeDirectoryChildren(
  root: WorkspaceTreeNode,
  directoryPath: string,
  entries: FilePreviewDirEntry[],
): WorkspaceTreeNode {
  return replaceTreeNode(root, directoryPath, (currentNode) => ({
    ...currentNode,
    hasChildren: entries.length > 0,
    childrenLoaded: true,
    children: entries.map(createWorkspaceTreeNode),
  }));
}

function buildAncestorDirectoryPaths(
  rootPath: string,
  targetPath: string,
  includeTarget: boolean,
): string[] {
  const normalizedRoot = normalizeWorkspacePath(rootPath);
  const normalizedTarget = normalizeWorkspacePath(targetPath);
  if (normalizedTarget === normalizedRoot) {
    return [rootPath];
  }

  const normalizedRootPrefix = `${normalizedRoot}/`;
  if (!normalizedTarget.startsWith(normalizedRootPrefix)) {
    return [];
  }

  const relative = normalizedTarget.slice(normalizedRootPrefix.length);
  const segments = relative.split('/').filter(Boolean);
  if (segments.length === 0) {
    return [rootPath];
  }

  const endIndex = includeTarget ? segments.length : segments.length - 1;
  if (endIndex <= 0) {
    return [rootPath];
  }

  const useBackslash = targetPath.includes('\\');
  const ancestors = [normalizedRoot];
  for (let index = 0; index < endIndex; index += 1) {
    ancestors.push(`${normalizedRoot}/${segments.slice(0, index + 1).join('/')}`);
  }
  return ancestors.map((path) => (useBackslash ? path.replace(/\//g, '\\') : path));
}

function FileTreeNodeRow(input: {
  node: WorkspaceTreeNode;
  depth: number;
  expandedPaths: Set<string>;
  loadingPaths: Set<string>;
  selectedFilePath: string | null;
  onToggle: (path: string) => void;
  onSelectFile: (file: ArtifactPreviewTarget) => void;
}): React.ReactNode {
  const { node, depth, expandedPaths, loadingPaths, selectedFilePath, onToggle, onSelectFile } = input;
  const isExpanded = expandedPaths.has(node.path);
  const hasChildren = nodeCanExpand(node);
  const isLoading = loadingPaths.has(node.path);
  const isSelected = selectedFilePath != null && isSameWorkspacePath(selectedFilePath, node.path);

  return (
    <div key={node.path}>
      <div
        className={cn(
          'flex items-center gap-1.5 rounded-md px-1.5 py-0.5 text-[13px] leading-5 transition-colors',
          isSelected
            ? 'bg-secondary text-foreground'
            : 'text-muted-foreground hover:bg-secondary hover:text-foreground',
        )}
        style={{ paddingLeft: `${depth * 12 + 6}px` }}
      >
        {node.isDir ? (
          <button
            type="button"
            data-testid="workspace-tree-node"
            data-path={node.path}
            onClick={() => onToggle(node.path)}
            className="flex min-w-0 flex-1 items-center gap-1.5 rounded-md py-0 text-left"
          >
            {hasChildren ? (
              isLoading
                ? <LoadingSpinner size="sm" className="h-3.5 w-3.5 shrink-0" />
                : isExpanded
                  ? <ChevronDown className="h-3.5 w-3.5 shrink-0" />
                  : <ChevronRight className="h-3.5 w-3.5 shrink-0" />
            ) : (
              <span className="h-3.5 w-3.5 shrink-0" />
            )}
            <FolderTree className="h-3.5 w-3.5 shrink-0" />
            <span className="truncate">{node.name}</span>
          </button>
        ) : (
          <button
            type="button"
            data-testid="workspace-tree-node"
            data-path={node.path}
            onClick={() => onSelectFile(toPreviewFile(node))}
            className="flex min-w-0 flex-1 items-center gap-1.5 rounded-md py-0 text-left"
          >
            <span className="ml-5 truncate">{node.name}</span>
          </button>
        )}
      </div>
      {node.isDir && isExpanded && node.children?.length ? (
        <div>
          {node.children.map((child) => FileTreeNodeRow({
            node: child,
            depth: depth + 1,
            expandedPaths,
            loadingPaths,
            selectedFilePath,
            onToggle,
            onSelectFile,
          }))}
        </div>
      ) : null}
    </div>
  );
}

export function WorkspaceBrowserBody({
  rootPath,
  selectedFilePath,
  selectedFile,
  runtimeAddress,
  availableWidth = Number.POSITIVE_INFINITY,
  previewMode = 'preview',
  onSelectFile,
  onPreviewModeChange,
  previewHeaderTrailingAccessory,
  className,
}: WorkspaceBrowserBodyProps) {
  const { t } = useTranslation('chat');
  const [treeState, setTreeState] = useState<TreeState>({ status: 'idle' });
  const [reloadToken, setReloadToken] = useState(0);
  const [expandedPaths, setExpandedPaths] = useState<Set<string>>(new Set());
  const [loadingPaths, setLoadingPaths] = useState<Set<string>>(new Set());
  const treeRef = useRef<WorkspaceTreeNode | null>(null);
  const treeVersionRef = useRef(0);
  const loadingPathsRef = useRef<Set<string>>(new Set());
  const effectiveRootPath = rootPath?.trim() || null;
  const workspaceLayout = useMemo(() => {
    if (availableWidth < WORKSPACE_SPLIT_MIN_WIDTH) {
      return {
        mode: 'stacked' as const,
        treeWidth: null,
      };
    }
    return {
      mode: 'split' as const,
      treeWidth: Math.min(
        WORKSPACE_TREE_DEFAULT_WIDTH,
        Math.max(WORKSPACE_TREE_MIN_WIDTH, Math.floor(availableWidth * 0.38)),
      ),
    };
  }, [availableWidth]);

  const applyReadyTree = (updater: (tree: WorkspaceTreeNode) => WorkspaceTreeNode) => {
    setTreeState((current) => {
      if (current.status !== 'ready') {
        return current;
      }
      const nextTree = updater(current.tree);
      treeRef.current = nextTree;
      return { status: 'ready', tree: nextTree };
    });
  };

  const replaceLoadingPaths = (next: Set<string>) => {
    loadingPathsRef.current = next;
    setLoadingPaths(next);
  };

  const updateLoadingPaths = (updater: (current: Set<string>) => Set<string>) => {
    setLoadingPaths((current) => {
      const next = updater(current);
      loadingPathsRef.current = next;
      return next;
    });
  };

  const ensureDirectoryChildrenLoaded = async (path: string, version: number): Promise<void> => {
    const currentTree = treeRef.current;
    const currentNode = currentTree ? findTreeNode(currentTree, path) : null;
    if (!currentNode || !currentNode.isDir || currentNode.childrenLoaded) {
      return;
    }
    if (loadingPathsRef.current.has(path)) {
      return;
    }

    updateLoadingPaths((current) => {
      const next = new Set(current);
      next.add(path);
      return next;
    });

    try {
      if (!runtimeAddress) {
        return;
      }
      const result = await hostFileListDir(
        {
          path,
          runtimeAddress,
        },
        {
          timeoutMs: WORKSPACE_DIR_LIST_TIMEOUT_MS,
        },
      );
      if (treeVersionRef.current !== version) {
        return;
      }
      if (!result.ok || !result.entries) {
        return;
      }
      startTransition(() => {
        applyReadyTree((tree) => mergeDirectoryChildren(tree, path, result.entries ?? []));
      });
    } finally {
      if (treeVersionRef.current === version) {
        updateLoadingPaths((current) => {
          if (!current.has(path)) {
            return current;
          }
          const next = new Set(current);
          next.delete(path);
          return next;
        });
      }
    }
  };

  useEffect(() => {
    if (!effectiveRootPath) {
      treeVersionRef.current += 1;
      treeRef.current = null;
      setTreeState({ status: 'idle' });
      setExpandedPaths(new Set());
      replaceLoadingPaths(new Set());
      return;
    }

    let cancelled = false;
    const version = treeVersionRef.current + 1;
    treeVersionRef.current = version;
    treeRef.current = null;
    setTreeState({ status: 'loading' });
    replaceLoadingPaths(new Set([effectiveRootPath]));
    setExpandedPaths(new Set());

    void (async () => {
      try {
        if (!runtimeAddress) {
          setTreeState({ status: 'error', message: 'RuntimeAddress is required' });
          replaceLoadingPaths(new Set());
          return;
        }
        const result = await hostFileListDir(
          {
            path: effectiveRootPath,
            runtimeAddress,
          },
          {
            timeoutMs: WORKSPACE_DIR_LIST_TIMEOUT_MS,
          },
        );
        if (cancelled || treeVersionRef.current !== version) {
          return;
        }
        if (!result.ok || !result.entries) {
          treeRef.current = null;
          replaceLoadingPaths(new Set());
          setTreeState({ status: 'error', message: String(result.error ?? 'unknown') });
          return;
        }
        const nextTree = createWorkspaceRootNode(effectiveRootPath, result.entries);
        treeRef.current = nextTree;
        startTransition(() => {
          replaceLoadingPaths(new Set());
          setTreeState({ status: 'ready', tree: nextTree });
          setExpandedPaths(new Set([nextTree.path]));
        });
      } catch (error) {
        if (cancelled || treeVersionRef.current !== version) {
          return;
        }
        treeRef.current = null;
        replaceLoadingPaths(new Set());
        setTreeState({
          status: 'error',
          message: error instanceof Error ? error.message : String(error),
        });
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [effectiveRootPath, reloadToken, runtimeAddress]);

  useEffect(() => {
    if (treeState.status !== 'ready' || !selectedFilePath) {
      return;
    }
    const includeTarget = selectedFile?.isDirectory === true;
    const ancestorPaths = buildAncestorDirectoryPaths(treeState.tree.path, selectedFilePath, includeTarget);
    if (ancestorPaths.length === 0) {
      return;
    }

    let cancelled = false;
    const version = treeVersionRef.current;

    void (async () => {
      for (const path of ancestorPaths) {
        if (cancelled || treeVersionRef.current !== version) {
          return;
        }
        setExpandedPaths((current) => {
          if (current.has(path)) {
            return current;
          }
          const next = new Set(current);
          next.add(path);
          return next;
        });

        const currentTree = treeRef.current;
        const node = currentTree ? findTreeNode(currentTree, path) : null;
        if (!node || !node.isDir || node.childrenLoaded) {
          continue;
        }
        await ensureDirectoryChildrenLoaded(path, version);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [selectedFile, selectedFilePath, treeState]);

  const handleTogglePath = (path: string) => {
    const shouldExpand = !expandedPaths.has(path);
    setExpandedPaths((current) => {
      const next = new Set(current);
      if (next.has(path)) {
        next.delete(path);
      } else {
        next.add(path);
      }
      return next;
    });

    if (!shouldExpand || treeState.status !== 'ready') {
      return;
    }
    const node = findTreeNode(treeState.tree, path);
    if (!node || !node.isDir || node.childrenLoaded) {
      return;
    }
    void ensureDirectoryChildrenLoaded(path, treeVersionRef.current);
  };

  const treeBody = useMemo(() => {
    if (treeState.status !== 'ready') {
      return null;
    }
    return FileTreeNodeRow({
      node: treeState.tree,
      depth: 0,
      expandedPaths,
      loadingPaths,
      selectedFilePath,
      onToggle: handleTogglePath,
      onSelectFile,
    });
  }, [expandedPaths, loadingPaths, onSelectFile, selectedFilePath, treeState]);

  return (
    <div
      data-testid="workspace-browser-body"
      data-layout={workspaceLayout.mode}
      className={cn(
        'min-h-0 h-full overflow-hidden',
        workspaceLayout.mode === 'split'
          ? 'grid'
          : 'grid',
        className,
      )}
      style={workspaceLayout.mode === 'split'
        ? { gridTemplateColumns: `minmax(${WORKSPACE_TREE_MIN_WIDTH}px, ${workspaceLayout.treeWidth}px) minmax(0,1fr)` }
        : { gridTemplateRows: `minmax(0, ${WORKSPACE_STACKED_TREE_HEIGHT}px) minmax(0,1fr)` }}
    >
      <div className={cn(
        'flex min-h-0 flex-col overflow-hidden',
        workspaceLayout.mode === 'split'
          ? 'border-r border-border/40'
          : 'border-b border-border/40',
      )}>
        <div className="flex items-center justify-between border-b border-border/40 px-3 py-2">
          <div className="min-w-0">
            <p className="truncate text-sm font-medium text-foreground">
              {t('artifacts.workspaceTab')}
            </p>
          </div>
          <div className="flex items-center gap-1">
            <Button
              type="button"
              variant="ghost"
              size="icon"
              className="h-7 w-7 rounded-md"
              onClick={() => setReloadToken((current) => current + 1)}
              disabled={!effectiveRootPath || treeState.status === 'loading'}
              title={t('common:actions.refresh', { defaultValue: 'Refresh' })}
              aria-label={t('common:actions.refresh', { defaultValue: 'Refresh' })}
            >
              {treeState.status === 'loading' ? <LoadingSpinner size="sm" /> : <RefreshCw className="h-4 w-4" />}
            </Button>
          </div>
        </div>
        <div className="min-h-0 flex-1 overflow-auto p-1.5">
          {treeState.status === 'idle' ? (
            <div className="flex h-full items-center justify-center px-4 text-center text-sm text-muted-foreground">
              {t('artifacts.workspaceEmpty')}
            </div>
          ) : null}
          {treeState.status === 'loading' ? (
            <div className="flex h-full items-center justify-center">
              <LoadingSpinner />
            </div>
          ) : null}
          {treeState.status === 'error' ? (
            <div className="flex h-full items-center justify-center px-4 text-center text-sm text-destructive">
              {t('artifacts.workspaceLoadFailed', { error: treeState.message })}
            </div>
          ) : null}
          {treeState.status === 'ready' ? treeBody : null}
        </div>
      </div>

      <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
        {selectedFile ? (
          <FilePreviewBody
            file={selectedFile}
            mode={supportsInlineDiff(selectedFile) ? previewMode : 'preview'}
            runtimeAddress={runtimeAddress}
            className="h-full"
            headerAccessory={(
              <>
                {supportsInlineDiff(selectedFile) ? (
                  <Button
                    type="button"
                    variant={previewMode === 'diff' ? 'secondary' : 'ghost'}
                    size="icon"
                    className="h-7 w-7 rounded-md"
                    onClick={() => onPreviewModeChange?.(previewMode === 'diff' ? 'preview' : 'diff')}
                    data-testid="workspace-preview-mode-diff"
                    title={previewMode === 'diff' ? t('artifacts.previewTab') : t('artifacts.changesTab')}
                    aria-label={previewMode === 'diff' ? t('artifacts.previewTab') : t('artifacts.changesTab')}
                  >
                    <GitCompare className="h-3.5 w-3.5" />
                  </Button>
                ) : null}
              </>
            )}
            headerTrailingAccessory={previewHeaderTrailingAccessory}
          />
        ) : (
          <div className="flex h-full items-center justify-center px-6 text-center text-sm text-muted-foreground">
            {t('artifacts.selectFile')}
          </div>
        )}
      </div>
    </div>
  );
}
