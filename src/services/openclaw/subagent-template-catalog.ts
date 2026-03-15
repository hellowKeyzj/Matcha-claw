import { invokeIpc } from '@/lib/api-client';
import type {
  SubagentTargetFile,
  SubagentTemplateCategory,
  SubagentTemplateCatalogResult,
  SubagentTemplateDetail,
  SubagentTemplateSummary,
} from '@/types/subagent';

const TEMPLATE_FILE_SET = new Set<SubagentTargetFile>([
  'AGENTS.md',
  'SOUL.md',
  'TOOLS.md',
  'IDENTITY.md',
  'USER.md',
]);

function normalizeTemplateEntry(value: unknown): SubagentTemplateSummary | null {
  if (!value || typeof value !== 'object') {
    return null;
  }
  const raw = value as {
    id?: unknown;
    name?: unknown;
    emoji?: unknown;
    summary?: unknown;
    categoryId?: unknown;
    subcategoryId?: unknown;
    order?: unknown;
    sourcePath?: unknown;
    files?: unknown;
  };
  const id = typeof raw.id === 'string' ? raw.id.trim() : '';
  const name = typeof raw.name === 'string' ? raw.name.trim() : '';
  if (!id || !name) {
    return null;
  }
  const files = Array.isArray(raw.files)
    ? raw.files
      .filter((file): file is string => typeof file === 'string')
      .map((file) => file.trim())
      .filter((file): file is SubagentTargetFile => TEMPLATE_FILE_SET.has(file as SubagentTargetFile))
    : [];
  if (files.length === 0) {
    return null;
  }
  const emoji = typeof raw.emoji === 'string' ? raw.emoji.trim() : '';
  const summary = typeof raw.summary === 'string' ? raw.summary.trim() : '';
  const categoryId = typeof raw.categoryId === 'string' ? raw.categoryId.trim() : '';
  const subcategoryId = typeof raw.subcategoryId === 'string' ? raw.subcategoryId.trim() : '';
  const sourcePath = typeof raw.sourcePath === 'string' ? raw.sourcePath.trim() : '';
  const order = typeof raw.order === 'number' && Number.isFinite(raw.order) ? raw.order : undefined;
  return {
    id,
    name,
    ...(emoji ? { emoji } : {}),
    ...(summary ? { summary } : {}),
    ...(categoryId ? { categoryId } : {}),
    ...(subcategoryId ? { subcategoryId } : {}),
    ...(order !== undefined ? { order } : {}),
    ...(sourcePath ? { sourcePath } : {}),
    files,
  };
}

function normalizeCategoryEntry(value: unknown): SubagentTemplateCategory | null {
  if (!value || typeof value !== 'object') {
    return null;
  }
  const raw = value as {
    id?: unknown;
    order?: unknown;
  };
  const id = typeof raw.id === 'string' ? raw.id.trim() : '';
  if (!id) {
    return null;
  }
  const order = typeof raw.order === 'number' && Number.isFinite(raw.order) ? raw.order : undefined;
  return {
    id,
    ...(order !== undefined ? { order } : {}),
  };
}

function normalizeTemplateFileContents(value: unknown): Partial<Record<SubagentTargetFile, string>> {
  if (!value || typeof value !== 'object') {
    return {};
  }
  const result: Partial<Record<SubagentTargetFile, string>> = {};
  for (const [key, rawContent] of Object.entries(value as Record<string, unknown>)) {
    if (!TEMPLATE_FILE_SET.has(key as SubagentTargetFile)) {
      continue;
    }
    const content = typeof rawContent === 'string' ? rawContent : '';
    result[key as SubagentTargetFile] = content;
  }
  return result;
}

export async function getSubagentTemplateCatalog(): Promise<SubagentTemplateCatalogResult> {
  const value = await invokeIpc<unknown>('openclaw:getSubagentTemplateCatalog');
  if (!value || typeof value !== 'object') {
    return {
      categories: [],
      templates: [],
    };
  }
  const raw = value as {
    sourceDir?: unknown;
    categories?: unknown;
    templates?: unknown;
  };
  const sourceDir = typeof raw.sourceDir === 'string' ? raw.sourceDir.trim() : '';
  const categories = Array.isArray(raw.categories)
    ? raw.categories
      .map((item) => normalizeCategoryEntry(item))
      .filter((item): item is SubagentTemplateCategory => Boolean(item))
    : [];
  const templates = Array.isArray(raw.templates)
    ? raw.templates
      .map((item) => normalizeTemplateEntry(item))
      .filter((item): item is SubagentTemplateSummary => Boolean(item))
    : [];
  return {
    ...(sourceDir ? { sourceDir } : {}),
    categories,
    templates,
  };
}

export async function getSubagentTemplateById(templateId: string): Promise<SubagentTemplateDetail> {
  const id = templateId.trim();
  if (!id) {
    throw new Error('Template id is required');
  }
  const value = await invokeIpc<unknown>('openclaw:getSubagentTemplate', id);
  if (!value || typeof value !== 'object') {
    throw new Error(`Template "${id}" not found`);
  }
  const raw = value as {
    sourceDir?: unknown;
    template?: unknown;
  };
  const normalizedTemplate = normalizeTemplateEntry(raw.template);
  if (!normalizedTemplate) {
    throw new Error(`Template "${id}" is invalid`);
  }
  const sourceDir = typeof raw.sourceDir === 'string' ? raw.sourceDir.trim() : '';
  const detailTemplate = raw.template as {
    fileContents?: unknown;
  };
  return {
    ...normalizedTemplate,
    ...(sourceDir ? { sourceDir } : {}),
    fileContents: normalizeTemplateFileContents(detailTemplate.fileContents),
  };
}
