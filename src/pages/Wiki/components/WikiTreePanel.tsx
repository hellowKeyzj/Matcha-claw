import type { ReactElement } from 'react';
import { useTranslation } from 'react-i18next';
import { ChevronRight, FileText, Folder } from 'lucide-react';
import { cn } from '@/lib/utils';
import type { WikiFileItem } from '../wiki-model';
import { formatFileSize } from '../wiki-model';

export type WikiTreePanelProps = Readonly<{
  files: readonly WikiFileItem[];
  expandedDirectories: ReadonlySet<string>;
  selectedPath: string;
  busy: string | null;
  onSelectFile(path: string): void;
  onToggleDirectory(path: string): void;
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

const TREE_SECTIONS: readonly { path: string; label: string }[] = [
  { path: 'wiki', label: 'Wiki' },
  { path: 'raw', label: 'Raw' },
];
const TREE_SECTION_PATHS = new Set(TREE_SECTIONS.map((section) => section.path));

function isDirectory(node: WikiTreeNode): boolean {
  return TREE_SECTION_PATHS.has(node.path) || node.item?.isDirectory === true || node.children.length > 0;
}

function findNode(nodes: readonly WikiTreeNode[], path: string): WikiTreeNode | null {
  for (const node of nodes) {
    if (node.path === path) return node;
    const child = findNode(node.children, path);
    if (child) return child;
  }
  return null;
}

function sectionRoots(nodes: readonly WikiTreeNode[]): readonly WikiTreeNode[] {
  return TREE_SECTIONS.map((section) => {
    const node = findNode(nodes, section.path);
    const children = node?.children
      ?? nodes.filter((candidate) => candidate.path.startsWith(`${section.path}/`) && pathSegments(candidate.path).length === pathSegments(section.path).length + 1);
    return {
      path: section.path,
      label: section.label,
      item: node?.item ?? null,
      children,
    };
  });
}

function TreeNodeRow(props: Readonly<{
  node: WikiTreeNode;
  depth: number;
  expandedDirectories: ReadonlySet<string>;
  selectedPath: string;
  busy: string | null;
  emptyDirectoryText: string;
  onSelectFile(path: string): void;
  onToggleDirectory(path: string): void;
}>): ReactElement {
  const { node, depth, expandedDirectories, selectedPath, busy, emptyDirectoryText, onSelectFile, onToggleDirectory } = props;
  const directory = isDirectory(node);
  const expanded = expandedDirectories.has(node.path);
  const selected = !directory && selectedPath === node.path;
  const iconPadding = { paddingLeft: `${depth * 12 + 10}px` };

  return (
    <>
      <button
        type="button"
        disabled={busy !== null}
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
        {!directory && node.item?.size ? <span className="shrink-0 text-[11px] text-muted-foreground">{formatFileSize(node.item.size)}</span> : null}
      </button>
      {directory && expanded && node.children.length > 0 ? node.children.map((child) => (
        <TreeNodeRow
          key={child.path}
          node={child}
          depth={depth + 1}
          expandedDirectories={expandedDirectories}
          selectedPath={selectedPath}
          busy={busy}
          emptyDirectoryText={emptyDirectoryText}
          onSelectFile={onSelectFile}
          onToggleDirectory={onToggleDirectory}
        />
      )) : null}
      {directory && expanded && node.children.length === 0 && busy === null ? (
        <div className="h-7 truncate text-xs text-muted-foreground" style={{ paddingLeft: `${(depth + 1) * 12 + 28}px` }}>{emptyDirectoryText}</div>
      ) : null}
    </>
  );
}

export function WikiTreePanel({ files, expandedDirectories, selectedPath, busy, onSelectFile, onToggleDirectory }: WikiTreePanelProps): ReactElement {
  const { t } = useTranslation('wiki');
  const tree = sectionRoots(buildTree(files));

  if (tree.length === 0) {
    return (
      <div className="rounded-2xl border border-dashed border-border bg-secondary/20 p-4 text-sm text-muted-foreground">
        {t('tree.empty')}
      </div>
    );
  }

  return (
    <div className="space-y-1">
      {tree.map((node) => (
        <TreeNodeRow
          key={node.path}
          node={node}
          depth={0}
          expandedDirectories={expandedDirectories}
          selectedPath={selectedPath}
          busy={busy}
          emptyDirectoryText={t('tree.emptyDirectory')}
          onSelectFile={onSelectFile}
          onToggleDirectory={onToggleDirectory}
        />
      ))}
    </div>
  );
}
