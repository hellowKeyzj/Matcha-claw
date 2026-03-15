import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve, join, relative } from 'node:path';

const SOURCE_AGENT_DIRS = [
  'design',
  'engineering',
  'game-development',
  'marketing',
  'paid-media',
  'sales',
  'product',
  'project-management',
  'testing',
  'support',
  'spatial-computing',
  'specialized',
];

function slugify(value) {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
}

function readFrontmatterField(content, field) {
  const match = content.match(/^---\n([\s\S]*?)\n---\n?/);
  if (!match) {
    return '';
  }
  const frontmatter = match[1];
  const fieldPattern = new RegExp(`^${field}:\\s*(.+)$`, 'mi');
  const fieldMatch = frontmatter.match(fieldPattern);
  return fieldMatch ? fieldMatch[1].trim() : '';
}

function walkMarkdownFiles(rootDir, collector = []) {
  const entries = readdirSync(rootDir, { withFileTypes: true });
  for (const entry of entries) {
    const absolutePath = join(rootDir, entry.name);
    if (entry.isDirectory()) {
      walkMarkdownFiles(absolutePath, collector);
      continue;
    }
    if (entry.isFile() && entry.name.endsWith('.md')) {
      collector.push(absolutePath);
    }
  }
  return collector;
}

function collectSourceTemplateIndex(agencyRoot) {
  const map = new Map();
  for (const topLevelDir of SOURCE_AGENT_DIRS) {
    const categoryRoot = join(agencyRoot, topLevelDir);
    const files = walkMarkdownFiles(categoryRoot, []);
    for (const filePath of files) {
      const content = readFileSync(filePath, 'utf8');
      if (!content.startsWith('---')) {
        continue;
      }
      const name = readFrontmatterField(content, 'name');
      if (!name) {
        continue;
      }
      const templateId = slugify(name);
      const sourcePath = relative(agencyRoot, filePath).replace(/\\/g, '/');
      const relativeDir = relative(categoryRoot, filePath).replace(/\\/g, '/');
      const dirParts = relativeDir.split('/').slice(0, -1).filter(Boolean);
      const subcategoryId = dirParts.length > 0 ? `${topLevelDir}/${dirParts.join('/')}` : undefined;
      map.set(templateId, {
        categoryId: topLevelDir,
        subcategoryId,
        sourcePath,
      });
    }
  }
  return map;
}

function listTemplateIds(templateRoot) {
  return readdirSync(templateRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort((a, b) => a.localeCompare(b));
}

function main() {
  const matchaRoot = resolve(process.cwd());
  const agencyRoot = resolve(matchaRoot, '../agency-agents');
  const templateRoot = resolve(matchaRoot, 'src/features/subagents/templates');
  const outputPath = resolve(templateRoot, 'catalog.json');

  const sourceMap = collectSourceTemplateIndex(agencyRoot);
  const templateIds = listTemplateIds(templateRoot);

  const categoriesInUse = new Set();
  const templates = [];
  const missing = [];

  for (let index = 0; index < templateIds.length; index += 1) {
    const id = templateIds[index];
    const source = sourceMap.get(id);
    if (!source) {
      missing.push(id);
      continue;
    }
    categoriesInUse.add(source.categoryId);
    templates.push({
      id,
      categoryId: source.categoryId,
      ...(source.subcategoryId ? { subcategoryId: source.subcategoryId } : {}),
      sourcePath: source.sourcePath,
      order: index + 1,
    });
  }

  const categories = SOURCE_AGENT_DIRS
    .filter((id) => categoriesInUse.has(id))
    .map((id, index) => ({
      id,
      order: (index + 1) * 10,
    }));

  const payload = {
    version: 1,
    generatedAt: new Date().toISOString(),
    categories,
    templates,
  };

  writeFileSync(outputPath, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');

  if (missing.length > 0) {
    throw new Error(`Missing source mapping for templates: ${missing.join(', ')}`);
  }

  process.stdout.write(
    `Generated catalog: ${outputPath}\nTemplates: ${templates.length}, Categories: ${categories.length}\n`,
  );
}

main();
