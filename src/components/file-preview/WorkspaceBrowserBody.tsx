import { startTransition, useEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import { ChevronDown, ChevronRight, FolderTree, GitCompare, PanelLeftClose, PanelLeftOpen, RefreshCw } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/button';
import { LoadingSpinner } from '@/components/common/LoadingSpinner';
import { hostFileListDir, type FilePreviewDirEntry, type WorkspaceFileContext } from '@/lib/host-api';
import { classifyFileContentType, extnameOf, getMimeTypeForPath, supportsInlineDiff } from '@/lib/generated-files';
import { cn } from '@/lib/utils';
import { FilePreviewBody, type FilePreviewMode } from './FilePreviewBody';
import { resolveWorkspaceRelativePath, type ArtifactPreviewTarget } from './types';
import type {
  SessionIdentity,
} from '../../../electron/desktop-contract/runtime-address';

interface WorkspaceBrowserBodyProps {
  rootPath: string | null;
  selectedFilePath: string | null;
  selectedFile: ArtifactPreviewTarget | null;
  sessionIdentity?: SessionIdentity;
  workspaceContext?: WorkspaceFileContext;
  availableWidth?: number;
  previewMode?: FilePreviewMode;
  onSelectFile: (file: ArtifactPreviewTarget) => void;
  onPreviewModeChange?: (mode: FilePreviewMode) => void;
  previewHeaderTrailingAccessory?: ReactNode;
  className?: string;
}

interface WorkspaceTreeNode {
  name: string;
  displayPath: string;
  relativePath: string;
  isDirectory: boolean;
  size: number;
  children?: WorkspaceTreeNode[];
  childrenLoaded: boolean;
  hasChildren: boolean;
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

function normalizeWorkspacePath(relativePath: string): string {
  const normalized = relativePath.replace(/\\/g, '/');
  if (/^[A-Za-z]:\/$/.test(normalized)) {
    return normalized;
  }
  if (normalized.length > 1) {
    return normalized.replace(/\/+$/, '');
  }
  return normalized;
}

function getWorkspaceNodeName(relativePath: string): string {
  const normalized = normalizeWorkspacePath(relativePath);
  if (/^[A-Za-z]:\/$/.test(normalized)) {
    return normalized;
  }
  const segments = normalized.split('/').filter(Boolean);
  return segments.at(-1) ?? normalized;
}

function joinWorkspaceDisplayPath(rootPath: string, relativePath: string): string {
  if (!relativePath) {
    return rootPath;
  }
  const normalizedRoot = normalizeWorkspacePath(rootPath);
  const rootWithSeparator = normalizedRoot.endsWith('/') ? normalizedRoot : `${normalizedRoot}/`;
  const displayPath = `${rootWithSeparator}${relativePath.replace(/\\/g, '/')}`;
  return rootPath.includes('\\') ? displayPath.replace(/\//g, '\\') : displayPath;
}

function createWorkspaceTreeNode(entry: FilePreviewDirEntry, workspaceRoot: string): WorkspaceTreeNode {
  return {
    name: entry.display,
    displayPath: joinWorkspaceDisplayPath(workspaceRoot, entry.relativePath),
    relativePath: entry.relativePath,
    isDirectory: entry.isDirectory,
    size: entry.size,
    hasChildren: entry.isDirectory,
    childrenLoaded: !entry.isDirectory,
  };
}

function createWorkspaceRootNode(
  rootPath: string,
  workspaceRoot: string,
  entries: FilePreviewDirEntry[],
): WorkspaceTreeNode {
  return {
    name: getWorkspaceNodeName(rootPath),
    displayPath: rootPath,
    relativePath: '',
    isDirectory: true,
    size: 0,
    hasChildren: entries.length > 0,
    childrenLoaded: true,
    children: entries.map((entry) => createWorkspaceTreeNode(entry, workspaceRoot)),
  };
}

function nodeCanExpand(node: WorkspaceTreeNode): boolean {
  if (!node.isDirectory) {
    return false;
  }
  if (!node.childrenLoaded) {
    return true;
  }
  return node.hasChildren;
}

function toPreviewFile(node: WorkspaceTreeNode): ArtifactPreviewTarget {
  const ext = extnameOf(node.displayPath);
  const mimeType = getMimeTypeForPath(node.displayPath);
  return {
    filePath: node.displayPath,
    relativePath: node.relativePath,
    fileName: node.name,
    ext,
    mimeType,
    contentType: classifyFileContentType(ext, mimeType),
    fileSize: node.size > 0 ? node.size : undefined,
  };
}

function findTreeNode(root: WorkspaceTreeNode, targetRelativePath: string): WorkspaceTreeNode | null {
  if (root.relativePath === targetRelativePath) {
    return root;
  }
  for (const child of root.children ?? []) {
    const matched = findTreeNode(child, targetRelativePath);
    if (matched) {
      return matched;
    }
  }
  return null;
}

function replaceTreeNode(
  root: WorkspaceTreeNode,
  targetRelativePath: string,
  update: (node: WorkspaceTreeNode) => WorkspaceTreeNode,
): WorkspaceTreeNode {
  if (root.relativePath === targetRelativePath) {
    return update(root);
  }
  if (!root.children?.length) {
    return root;
  }

  let changed = false;
  const nextChildren = root.children.map((child) => {
    const nextChild = replaceTreeNode(child, targetRelativePath, update);
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
  directoryRelativePath: string,
  workspaceRoot: string,
  entries: FilePreviewDirEntry[],
): WorkspaceTreeNode {
  return replaceTreeNode(root, directoryRelativePath, (currentNode) => ({
    ...currentNode,
    hasChildren: entries.length > 0,
    childrenLoaded: true,
    children: entries.map((entry) => createWorkspaceTreeNode(entry, workspaceRoot)),
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
    return [''];
  }

  const normalizedRootPrefix = normalizedRoot.endsWith('/') ? normalizedRoot : `${normalizedRoot}/`;
  if (!normalizedTarget.startsWith(normalizedRootPrefix)) {
    return [];
  }

  const relative = normalizedTarget.slice(normalizedRootPrefix.length);
  const segments = relative.split('/').filter(Boolean);
  if (segments.length === 0) {
    return [''];
  }

  const endIndex = includeTarget ? segments.length : segments.length - 1;
  if (endIndex <= 0) {
    return [''];
  }

  const ancestors = [''];
  for (let index = 0; index < endIndex; index += 1) {
    ancestors.push(segments.slice(0, index + 1).join('/'));
  }
  return ancestors;
}

function FileTreeNodeRow(input: {
  node: WorkspaceTreeNode;
  depth: number;
  expandedPaths: Set<string>;
  loadingPaths: Set<string>;
  selectedFileRelativePath: string | null;
  onToggle: (relativePath: string) => void;
  onSelectFile: (file: ArtifactPreviewTarget) => void;
}): React.ReactNode {
  const { node, depth, expandedPaths, loadingPaths, selectedFileRelativePath, onToggle, onSelectFile } = input;
  const isExpanded = expandedPaths.has(node.relativePath);
  const hasChildren = nodeCanExpand(node);
  const isLoading = loadingPaths.has(node.relativePath);
  const isSelected = selectedFileRelativePath != null && selectedFileRelativePath === node.relativePath;

  return (
    <div key={node.relativePath}>
      <div
        className={cn(
          'flex items-center gap-1.5 rounded-md px-1.5 py-0.5 text-[13px] leading-5 transition-colors',
          isSelected
            ? 'bg-secondary text-foreground'
            : 'text-muted-foreground hover:bg-secondary hover:text-foreground',
        )}
        style={{ paddingLeft: `${depth * 12 + 6}px` }}
      >
        {node.isDirectory ? (
          <button
            type="button"
            data-testid="workspace-tree-node"
            data-path={node.displayPath}
            onClick={() => onToggle(node.relativePath)}
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
            data-path={node.displayPath}
            onClick={() => onSelectFile(toPreviewFile(node))}
            className="flex min-w-0 flex-1 items-center gap-1.5 rounded-md py-0 text-left"
          >
            <span className="ml-5 truncate">{node.name}</span>
          </button>
        )}
      </div>
      {node.isDirectory && isExpanded && node.children?.length ? (
        <div>
          {node.children.map((child) => FileTreeNodeRow({
            node: child,
            depth: depth + 1,
            expandedPaths,
            loadingPaths,
            selectedFileRelativePath,
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
  sessionIdentity,
  workspaceContext,
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
  const [treeCollapsed, setTreeCollapsed] = useState(false);
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

  const ensureDirectoryChildrenLoaded = async (relativePath: string, version: number): Promise<void> => {
    const workspaceRoot = effectiveRootPath;
    if (!workspaceRoot) {
      return;
    }
    const currentTree = treeRef.current;
    const currentNode = currentTree ? findTreeNode(currentTree, relativePath) : null;
    if (!currentNode || !currentNode.isDirectory || currentNode.childrenLoaded) {
      return;
    }
    if (loadingPathsRef.current.has(relativePath)) {
      return;
    }

    updateLoadingPaths((current) => {
      const next = new Set(current);
      next.add(relativePath);
      return next;
    });

    try {
      if (!sessionIdentity) {
        return;
      }
      const result = await hostFileListDir(
        {
          endpoint: sessionIdentity.endpoint,
          sessionKey: sessionIdentity.sessionKey,
          relativePath,
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
        applyReadyTree((tree) => mergeDirectoryChildren(tree, relativePath, workspaceRoot, result.entries ?? []));
      });
    } finally {
      if (treeVersionRef.current === version) {
        updateLoadingPaths((current) => {
          if (!current.has(relativePath)) {
            return current;
          }
          const next = new Set(current);
          next.delete(relativePath);
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
    replaceLoadingPaths(new Set(['']));
    setExpandedPaths(new Set());

    void (async () => {
      try {
        if (!sessionIdentity) {
          setTreeState({ status: 'error', message: 'SessionIdentity is required' });
          replaceLoadingPaths(new Set());
          return;
        }
        const result = await hostFileListDir(
          {
            endpoint: sessionIdentity.endpoint,
            sessionKey: sessionIdentity.sessionKey,
            relativePath: '',
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
        const nextTree = createWorkspaceRootNode(effectiveRootPath, effectiveRootPath, result.entries);
        treeRef.current = nextTree;
        startTransition(() => {
          replaceLoadingPaths(new Set());
          setTreeState({ status: 'ready', tree: nextTree });
          setExpandedPaths(new Set([nextTree.relativePath]));
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
  }, [effectiveRootPath, reloadToken, sessionIdentity]);

  useEffect(() => {
    const workspaceRoot = effectiveRootPath;
    if (treeState.status !== 'ready' || !selectedFilePath || !workspaceRoot) {
      return;
    }
    const includeTarget = selectedFile?.isDirectory === true;
    const selectedFileRelativePath = selectedFile?.relativePath
      ?? resolveWorkspaceRelativePath(selectedFilePath, workspaceRoot);
    if (selectedFileRelativePath == null) {
      return;
    }
    const ancestorPaths = buildAncestorDirectoryPaths(workspaceRoot, joinWorkspaceDisplayPath(workspaceRoot, selectedFileRelativePath), includeTarget);
    if (ancestorPaths.length === 0) {
      return;
    }

    let cancelled = false;
    const version = treeVersionRef.current;

    void (async () => {
      for (const relativePath of ancestorPaths) {
        if (cancelled || treeVersionRef.current !== version) {
          return;
        }
        setExpandedPaths((current) => {
          if (current.has(relativePath)) {
            return current;
          }
          const next = new Set(current);
          next.add(relativePath);
          return next;
        });

        const currentTree = treeRef.current;
        const node = currentTree ? findTreeNode(currentTree, relativePath) : null;
        if (!node || !node.isDirectory || node.childrenLoaded) {
          continue;
        }
        await ensureDirectoryChildrenLoaded(relativePath, version);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [selectedFile, selectedFilePath, treeState]);

  const handleTogglePath = (relativePath: string) => {
    const shouldExpand = !expandedPaths.has(relativePath);
    setExpandedPaths((current) => {
      const next = new Set(current);
      if (next.has(relativePath)) {
        next.delete(relativePath);
      } else {
        next.add(relativePath);
      }
      return next;
    });

    if (!shouldExpand || treeState.status !== 'ready') {
      return;
    }
    const node = findTreeNode(treeState.tree, relativePath);
    if (!node || !node.isDirectory || node.childrenLoaded) {
      return;
    }
    void ensureDirectoryChildrenLoaded(relativePath, treeVersionRef.current);
  };

  const treeBody = useMemo(() => {
    if (treeState.status !== 'ready') {
      return null;
    }
    const selectedFileRelativePath = selectedFile?.relativePath
      ?? (selectedFilePath && effectiveRootPath
        ? resolveWorkspaceRelativePath(selectedFilePath, effectiveRootPath)
        : null);
    return FileTreeNodeRow({
      node: treeState.tree,
      depth: 0,
      expandedPaths,
      loadingPaths,
      selectedFileRelativePath,
      onToggle: handleTogglePath,
      onSelectFile,
    });
  }, [effectiveRootPath, expandedPaths, loadingPaths, onSelectFile, selectedFile?.relativePath, selectedFilePath, treeState]);

  const treeToggleLabel = treeCollapsed
    ? t('artifacts.expandWorkspaceTree')
    : t('artifacts.collapseWorkspaceTree');
  const workspaceTreeToggleButton = (
    <Button
      type="button"
      variant="ghost"
      size="icon"
      className="h-7 w-7 rounded-md"
      onClick={() => setTreeCollapsed((current) => !current)}
      title={treeToggleLabel}
      aria-label={treeToggleLabel}
      aria-expanded={!treeCollapsed}
      data-testid="workspace-tree-collapse-toggle"
    >
      {treeCollapsed ? <PanelLeftOpen className="h-4 w-4" /> : <PanelLeftClose className="h-4 w-4" />}
    </Button>
  );
  const workspaceBrowserStyle = useMemo<CSSProperties>(() => {
    if (workspaceLayout.mode === 'split') {
      return {
        gridTemplateColumns: treeCollapsed
          ? 'minmax(0,1fr)'
          : `minmax(${WORKSPACE_TREE_MIN_WIDTH}px, ${workspaceLayout.treeWidth}px) minmax(0,1fr)`,
      };
    }
    return {
      gridTemplateRows: treeCollapsed
        ? 'minmax(0,1fr)'
        : `minmax(0, ${WORKSPACE_STACKED_TREE_HEIGHT}px) minmax(0,1fr)`,
    };
  }, [treeCollapsed, workspaceLayout.mode, workspaceLayout.treeWidth]);

  return (
    <div
      data-testid="workspace-browser-body"
      data-layout={workspaceLayout.mode}
      data-tree-collapsed={treeCollapsed ? 'true' : 'false'}
      className={cn('relative grid min-h-0 h-full overflow-hidden', className)}
      style={workspaceBrowserStyle}
    >
      {treeCollapsed && !selectedFile ? (
        <div className="absolute left-3 top-2 z-20">
          {workspaceTreeToggleButton}
        </div>
      ) : null}

      {treeCollapsed ? null : (
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
              {workspaceTreeToggleButton}
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
      )}

      <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
        {selectedFile ? (
          <FilePreviewBody
            file={selectedFile}
            mode={supportsInlineDiff(selectedFile) ? previewMode : 'preview'}
            sessionIdentity={sessionIdentity}
            workspaceContext={workspaceContext}
            className="h-full"
            headerLeadingAccessory={treeCollapsed ? workspaceTreeToggleButton : null}
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
