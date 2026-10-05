export type WikiNavigationPage = Readonly<{
  path: string;
  title: string;
  type: string;
  tags: readonly string[];
  origin?: string;
  sources: readonly string[];
}>;

export type WikiNavigation = Readonly<{
  projectId: string;
  pages: readonly WikiNavigationPage[];
}>;

export function decodeWikiNavigation(value: unknown): WikiNavigation {
  if (!record(value) || !exact(value, ['projectId', 'pages']) || typeof value.projectId !== 'string'
    || !Array.isArray(value.pages) || !value.pages.every(page)) throw new Error('Invalid Wiki navigation');
  return value as unknown as WikiNavigation;
}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function exact(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key));
}

function strings(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === 'string');
}

function page(value: unknown): value is WikiNavigationPage {
  if (!record(value) || !exact(value, ['path', 'title', 'type', 'tags', 'sources', ...(Object.hasOwn(value, 'origin') ? ['origin'] : [])])) return false;
  return typeof value.path === 'string' && value.path.startsWith('wiki/') && value.path.endsWith('.md')
    && !value.path.includes('\\') && !value.path.includes('\0')
    && value.path.split('/').every((part) => part !== '..' && part !== '.' && part !== '')
    && !value.path.startsWith('wiki/media/') && !['index.md', 'log.md'].includes(value.path.split('/').at(-1) ?? '')
    && typeof value.title === 'string' && typeof value.type === 'string' && value.type.length > 0
    && strings(value.tags) && strings(value.sources)
    && (!Object.hasOwn(value, 'origin') || typeof value.origin === 'string');
}
