import { useMemo, type ReactElement } from 'react';
import { useTranslation } from 'react-i18next';
import { ChevronRight, FileText, Folder, Loader2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import type { WikiFileItem } from '../wiki-model';
import { formatFileSize } from '../wiki-model';

export type WikiTreePanelProps = Readonly<{
  files: readonly WikiFileItem[];
  expandedDirectories: ReadonlySet<string>;
  loadedDirectories: ReadonlySet<string>;
  loadingDirectories: ReadonlySet<string>;
  directoryErrors: Readonly<Record<string, string>>;
  selectedPath: string;
  busy: string | null;
  onSelectFile(path: string): void;
  onToggleDirectory(path: string): void;
  onRetryDirectory(path: string): void;
}>;

type WikiTreeNode = Readonly<{
  path: string;
  label: string;
  item: WikiFileItem | null;
  children: WikiTreeNode[];
}>;

function pathSegments(path: string): string[] {
  return path.replace(/\\/g, '/').split('/').filter(Boolean);
}

function nodePath(parentPath: string, label: string): string {
  return parentPath ? `${parentPath}/${label}` : label;
}

function insertNode(nodes: Map<string, WikiTreeNode>, item: WikiFileItem): void {
  const segments = pathSegments(item.path);
  let parentPath = '';
  for (const segment of segments) {
    const path = nodePath(parentPath, segment);
    if (!nodes.has(path)) {
      nodes.set(path, { path, label: segment, item: null, children: [] });
    }
    parentPath = path;
  }
  const existing = nodes.get(item.path.replace(/\\/g, '/'));
  if (existing) {
    nodes.set(existing.path, { ...existing, item });
  }
}

function buildTree(files: readonly WikiFileItem[]): WikiTreeNode[] {
  const nodes = new Map<string, WikiTreeNode>();
  for (const item of files) insertNode(nodes, item);

  const roots: WikiTreeNode[] = [];
  const mutableNodes = new Map([...nodes].map(([path, node]) => [path, { ...node, children: [] as WikiTreeNode[] }]));
  for (const node of mutableNodes.values()) {
    const segments = pathSegments(node.path);
    const parent = segments.length > 1 ? mutableNodes.get(segments.slice(0, -1).join('/')) : null;
    if (parent) parent.children.push(node);
    else roots.push(node);
  }

  const sortNodes = (items: WikiTreeNode[]) => {
    items.sort((left, right) => Number(isDirectory(right)) - Number(isDirectory(left)) || left.label.localeCompare(right.label));
    for (const item of items) sortNodes(item.children);
  };
  sortNodes(roots);
  return roots;
}

function isDirectory(node: WikiTreeNode): boolean {
  return node.item?.isDirectory === true || node.children.length > 0;
}

function TreeNodeRow(props: WikiTreePanelProps & Readonly<{ node: WikiTreeNode; depth: number }>): ReactElement {
  const { t } = useTranslation('wiki');
  const { node, depth, expandedDirectories, loadedDirectories, loadingDirectories, directoryErrors, selectedPath, busy, onSelectFile, onToggleDirectory, onRetryDirectory } = props;
  const directory = isDirectory(node);
  const expanded = expandedDirectories.has(node.path);
  const loading = loadingDirectories.has(node.path);
  const error = directoryErrors[node.path];
  const selected = !directory && selectedPath === node.path;
  const iconPadding = { paddingLeft: `${depth * 12 + 10}px` };

  return (
    <>
      <button
        type="button"
        disabled={busy !== null}
        aria-expanded={directory ? expanded : undefined}
        aria-current={selected ? 'page' : undefined}
        title={node.path}
        onClick={() => directory ? onToggleDirectory(node.path) : onSelectFile(node.path)}
        className={cn(
          'flex h-8 w-full min-w-0 items-center gap-1.5 rounded-xl pr-2 text-left text-sm transition-colors hover:bg-card disabled:opacity-60',
          selected && 'bg-card text-foreground shadow-sm ring-1 ring-border/70 hover:bg-card',
          directory && 'text-foreground',
        )}
        style={iconPadding}
      >
        {directory ? (
          <ChevronRight className={cn('h-3.5 w-3.5 shrink-0 text-muted-foreground transition-transform', expanded && 'rotate-90')} />
        ) : (
          <span className="w-3.5 shrink-0" />
        )}
        {directory ? <Folder className="h-4 w-4 shrink-0 text-muted-foreground" /> : <FileText className="h-4 w-4 shrink-0 text-muted-foreground" />}
        <span className="min-w-0 flex-1 truncate">{node.label}</span>
        {loading ? <Loader2 role="status" aria-label={t('sidebar.loading')} className="h-3.5 w-3.5 shrink-0 animate-spin text-muted-foreground motion-reduce:animate-none" /> : null}
        {!directory && node.item?.size ? <span className="shrink-0 text-[11px] text-muted-foreground">{formatFileSize(node.item.size)}</span> : null}
      </button>
      {directory && expanded ? (
        <>
          {error ? (
            <div role="alert" className="py-1 pr-2 text-xs text-destructive" style={{ paddingLeft: `${(depth + 1) * 12 + 10}px` }}>
              <p className="break-words">{error}</p>
              <Button type="button" size="sm" variant="ghost" disabled={busy !== null || loading} className="h-7 px-2 text-xs" onClick={() => onRetryDirectory(node.path)}>{t('sidebar.retry')}</Button>
            </div>
          ) : null}
          {node.children.map((child) => <TreeNodeRow key={child.path} {...props} node={child} depth={depth + 1} />)}
          {node.children.length === 0 && loadedDirectories.has(node.path) && !loading && !error ? (
            <div className="h-7 truncate text-xs text-muted-foreground" style={{ paddingLeft: `${(depth + 1) * 12 + 28}px` }}>{t('tree.emptyDirectory')}</div>
          ) : null}
        </>
      ) : null}
    </>
  );
}

export function WikiTreePanel(props: WikiTreePanelProps): ReactElement {
  const { t } = useTranslation('wiki');
  const tree = useMemo(() => buildTree(props.files), [props.files]);
  const loading = props.loadingDirectories.has('');
  const error = props.directoryErrors[''];

  return (
    <div className="space-y-1" aria-busy={loading}>
      {loading ? <p role="status" className="p-2 text-xs text-muted-foreground">{t('sidebar.loading')}</p> : null}
      {error ? (
        <div role="alert" className="p-2 text-xs text-destructive">
          <p className="break-words">{error}</p>
          <Button type="button" size="sm" variant="ghost" disabled={props.busy !== null || loading} className="mt-1 h-7 px-2 text-xs" onClick={() => props.onRetryDirectory('')}>{t('sidebar.retry')}</Button>
        </div>
      ) : null}
      {tree.length === 0 && !loading && !error ? (
        <div className="rounded-2xl border border-dashed border-border bg-secondary/20 p-4 text-sm text-muted-foreground">{t('tree.empty')}</div>
      ) : null}
      {tree.map((node) => <TreeNodeRow key={node.path} {...props} node={node} depth={0} />)}
    </div>
  );
}
