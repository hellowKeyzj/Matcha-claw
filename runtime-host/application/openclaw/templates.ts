import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { expandHomePath } from '../../api/storage/paths';

type TemplateFileName = 'AGENTS.md' | 'SOUL.md' | 'TOOLS.md' | 'IDENTITY.md' | 'USER.md';

type TemplateCatalogEntry = {
  id: string;
  name: string;
  emoji?: string;
  summary?: string;
  categoryId?: string;
  subcategoryId?: string;
  order?: number;
  sourcePath?: string;
  files: TemplateFileName[];
};

type TemplateCategoryEntry = {
  id: string;
  order?: number;
};

export type SubagentTemplateCatalogResult = {
  sourceDir?: string;
  categories: TemplateCategoryEntry[];
  templates: TemplateCatalogEntry[];
};

export type SubagentTemplateDetail = {
  sourceDir?: string;
  template: TemplateCatalogEntry & {
    fileContents: Partial<Record<TemplateFileName, string>>;
  };
};

type TemplateCatalogMetadataTemplate = {
  categoryId?: string;
  subcategoryId?: string;
  order?: number;
  sourcePath?: string;
};

type TemplateCatalogMetadata = {
  categories: TemplateCategoryEntry[];
  templates: Record<string, TemplateCatalogMetadataTemplate>;
};

const TEMPLATE_REQUIRED_FILES: readonly TemplateFileName[] = [
  'AGENTS.md',
  'SOUL.md',
  'TOOLS.md',
  'IDENTITY.md',
  'USER.md',
];

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function toDisplayNameFromSlug(slug: string): string {
  return slug
    .split(/[-_]+/)
    .filter(Boolean)
    .map((token) => token.charAt(0).toUpperCase() + token.slice(1))
    .join(' ');
}

function looksLikeEmojiToken(token: string): boolean {
  return /[\p{Extended_Pictographic}\uFE0F]/u.test(token);
}

function getFirstBodyLine(content: string): string | undefined {
  const lines = content.split(/\r?\n/);
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) {
      continue;
    }
    return trimmed;
  }
  return undefined;
}

function parseIdentityMetadata(identityContent: string, fallbackName: string): {
  name: string;
  emoji?: string;
  summary?: string;
} {
  const lines = identityContent.split(/\r?\n/);
  let name = fallbackName;
  let emoji: string | undefined;
  let summary: string | undefined;

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) {
      continue;
    }
    if (trimmed.startsWith('#')) {
      const heading = trimmed.replace(/^#+\s*/, '').trim();
      if (!heading) {
        continue;
      }
      const parts = heading.split(/\s+/);
      if (parts.length > 1 && looksLikeEmojiToken(parts[0])) {
        emoji = parts[0];
        name = parts.slice(1).join(' ') || fallbackName;
      } else {
        name = heading;
      }
      continue;
    }
    summary = trimmed;
    break;
  }

  return { name, emoji, summary };
}

function normalizeCategoryId(value: unknown): string | undefined {
  if (typeof value !== 'string') {
    return undefined;
  }
  const normalized = value.trim();
  return normalized ? normalized : undefined;
}

function normalizeOrder(value: unknown): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return undefined;
  }
  return value;
}

function resolveCandidates() {
  const cwd = process.cwd();
  const candidates = [
    process.env.MATCHACLAW_SUBAGENT_TEMPLATE_DIR,
    join(cwd, 'src', 'features', 'subagents', 'templates'),
    join(cwd, 'resources', 'subagent-templates'),
    join(homedir(), '.openclaw', 'agency-agents'),
  ]
    .filter((value) => typeof value === 'string' && value.trim().length > 0)
    .map((value) => resolve(expandHomePath(value)));
  return [...new Set(candidates)];
}

function readTemplateCatalogMetadata(sourceDir: string): TemplateCatalogMetadata {
  const catalogPath = join(sourceDir, 'catalog.json');
  if (!existsSync(catalogPath)) {
    return { categories: [], templates: {} };
  }
  try {
    const rawText = readFileSync(catalogPath, 'utf8');
    const parsed = JSON.parse(rawText);
    if (!isRecord(parsed)) {
      return { categories: [], templates: {} };
    }

    const rawCategories = Array.isArray(parsed.categories) ? parsed.categories : [];
    const categories = rawCategories
      .map((item): TemplateCategoryEntry | null => {
        if (!isRecord(item)) return null;
        const id = normalizeCategoryId(item.id);
        if (!id) return null;
        const order = normalizeOrder(item.order);
        return { id, ...(order !== undefined ? { order } : {}) };
      })
      .filter((item): item is TemplateCategoryEntry => Boolean(item));

    const rawTemplates = Array.isArray(parsed.templates) ? parsed.templates : [];
    const templates: Record<string, TemplateCatalogMetadataTemplate> = {};
    for (const item of rawTemplates) {
      if (!isRecord(item)) continue;
      const id = normalizeCategoryId(item.id);
      if (!id) continue;
      const categoryId = normalizeCategoryId(item.categoryId);
      const subcategoryId = normalizeCategoryId(item.subcategoryId);
      const order = normalizeOrder(item.order);
      const sourcePath = normalizeCategoryId(item.sourcePath);
      templates[id] = {
        ...(categoryId ? { categoryId } : {}),
        ...(subcategoryId ? { subcategoryId } : {}),
        ...(order !== undefined ? { order } : {}),
        ...(sourcePath ? { sourcePath } : {}),
      };
    }

    return { categories, templates };
  } catch {
    return { categories: [], templates: {} };
  }
}

function deriveTemplateCategories(
  templates: TemplateCatalogEntry[],
  metadataCategories: TemplateCategoryEntry[],
): TemplateCategoryEntry[] {
  const usedIds = new Set(
    templates
      .map((template) => template.categoryId)
      .filter((value): value is string => typeof value === 'string' && value.length > 0),
  );
  if (usedIds.size === 0) {
    return [];
  }

  const fromMetadata = metadataCategories
    .filter((category) => usedIds.has(category.id))
    .sort((a, b) => {
      const aOrder = a.order ?? Number.MAX_SAFE_INTEGER;
      const bOrder = b.order ?? Number.MAX_SAFE_INTEGER;
      if (aOrder !== bOrder) {
        return aOrder - bOrder;
      }
      return a.id.localeCompare(b.id);
    });

  const knownIds = new Set(fromMetadata.map((category) => category.id));
  const fallback = [...usedIds]
    .filter((id) => !knownIds.has(id))
    .sort((a, b) => a.localeCompare(b))
    .map((id) => ({ id }));

  return [...fromMetadata, ...fallback];
}

function listTemplatesFromSource(sourceDir: string): TemplateCatalogEntry[] {
  const metadata = readTemplateCatalogMetadata(sourceDir);
  const entries = readdirSync(sourceDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name);
  const templates: TemplateCatalogEntry[] = [];

  for (const id of entries) {
    const templateDir = join(sourceDir, id);
    const files = TEMPLATE_REQUIRED_FILES.filter((fileName) => existsSync(join(templateDir, fileName)));
    if (files.length === 0) {
      continue;
    }

    const identityPath = join(templateDir, 'IDENTITY.md');
    const agentsPath = join(templateDir, 'AGENTS.md');
    const fallbackName = toDisplayNameFromSlug(id) || id;
    const templateMetadata = metadata.templates[id];

    const identityContent = existsSync(identityPath) ? readFileSync(identityPath, 'utf8') : '';
    const agentsContent = existsSync(agentsPath) ? readFileSync(agentsPath, 'utf8') : '';
    const identity = parseIdentityMetadata(identityContent, fallbackName);
    const summary = identity.summary ?? getFirstBodyLine(agentsContent);

    templates.push({
      id,
      name: identity.name || fallbackName,
      ...(identity.emoji ? { emoji: identity.emoji } : {}),
      ...(summary ? { summary } : {}),
      ...(templateMetadata?.categoryId ? { categoryId: templateMetadata.categoryId } : {}),
      ...(templateMetadata?.subcategoryId ? { subcategoryId: templateMetadata.subcategoryId } : {}),
      ...(templateMetadata?.order !== undefined ? { order: templateMetadata.order } : {}),
      ...(templateMetadata?.sourcePath ? { sourcePath: templateMetadata.sourcePath } : {}),
      files: [...files],
    });
  }

  return templates.sort((a, b) => {
    const aOrder = a.order ?? Number.MAX_SAFE_INTEGER;
    const bOrder = b.order ?? Number.MAX_SAFE_INTEGER;
    if (aOrder !== bOrder) {
      return aOrder - bOrder;
    }
    return a.id.localeCompare(b.id);
  });
}

function readTemplateDetailFromSource(sourceDir: string, templateId: string): SubagentTemplateDetail | undefined {
  const templates = listTemplatesFromSource(sourceDir);
  const base = templates.find((item) => item.id === templateId);
  if (!base) {
    return undefined;
  }
  const templateDir = join(sourceDir, templateId);
  const fileContents: Partial<Record<TemplateFileName, string>> = {};
  for (const fileName of TEMPLATE_REQUIRED_FILES) {
    const filePath = join(templateDir, fileName);
    if (!existsSync(filePath)) {
      continue;
    }
    fileContents[fileName] = readFileSync(filePath, 'utf8');
  }
  return {
    sourceDir,
    template: {
      ...base,
      fileContents,
    },
  };
}

export class SubagentTemplateService {
  listCatalog(): SubagentTemplateCatalogResult {
    const candidates = resolveCandidates();
    for (const candidate of candidates) {
      if (!existsSync(candidate)) {
        continue;
      }
      try {
        const templates = listTemplatesFromSource(candidate);
        if (templates.length > 0) {
          const metadata = readTemplateCatalogMetadata(candidate);
          const categories = deriveTemplateCategories(templates, metadata.categories);
          return {
            sourceDir: candidate,
            categories,
            templates,
          };
        }
      } catch {
        // ignore malformed source and continue
      }
    }
    return {
      categories: [],
      templates: [],
    };
  }

  getTemplate(templateIdRaw: unknown): SubagentTemplateDetail | null {
    const templateId = typeof templateIdRaw === 'string' ? templateIdRaw.trim() : '';
    if (!templateId) {
      return null;
    }
    const candidates = resolveCandidates();
    for (const sourceDir of candidates) {
      if (!existsSync(sourceDir)) {
        continue;
      }
      try {
        const detail = readTemplateDetailFromSource(sourceDir, templateId);
        if (detail) {
          return detail;
        }
      } catch {
        // ignore malformed source and continue
      }
    }
    return null;
  }
}
