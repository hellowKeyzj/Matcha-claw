import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const TEMPLATE_REQUIRED_FILES = ['AGENTS.md', 'SOUL.md', 'TOOLS.md', 'IDENTITY.md', 'USER.md'];

function looksLikeEmojiToken(token) {
  return /[\p{Extended_Pictographic}\uFE0F]/u.test(token);
}

function getFirstBodyLine(content) {
  const lines = content.split(/\r?\n/);
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) {
      continue;
    }
    return trimmed;
  }
  return '';
}

function parseIdentityMetadata(identityContent, fallbackName) {
  const lines = identityContent.split(/\r?\n/);
  let name = fallbackName;
  let emoji;
  let summary;

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

function toDisplayNameFromSlug(slug) {
  return slug
    .split(/[-_]+/)
    .filter(Boolean)
    .map((token) => token.charAt(0).toUpperCase() + token.slice(1))
    .join(' ');
}

function cjkRatio(text) {
  if (!text) {
    return 0;
  }
  const chars = [...text];
  if (chars.length === 0) {
    return 0;
  }
  const cjkCount = chars.filter((char) => /[\u3400-\u9fff]/u.test(char)).length;
  return cjkCount / chars.length;
}

function isMostlyCjk(text) {
  return cjkRatio(text) >= 0.35;
}

async function getEdgeTranslateToken() {
  const response = await fetch('https://edge.microsoft.com/translate/auth', {
    method: 'GET',
    headers: { 'User-Agent': 'MatchaClaw/1.0' },
  });
  if (!response.ok) {
    throw new Error(`Edge auth failed: HTTP ${response.status}`);
  }
  const token = (await response.text()).trim();
  if (!token) {
    throw new Error('Edge auth returned empty token');
  }
  return token;
}

async function translateBatchWithEdge(token, texts) {
  if (texts.length === 0) {
    return [];
  }
  const response = await fetch(
    'https://api-edge.cognitive.microsofttranslator.com/translate?api-version=3.0&from=en&to=zh-Hans',
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
        'User-Agent': 'MatchaClaw/1.0',
      },
      body: JSON.stringify(texts.map((text) => ({ Text: text }))),
    },
  );
  if (!response.ok) {
    throw new Error(`Edge translate failed: HTTP ${response.status}`);
  }
  const payload = await response.json();
  if (!Array.isArray(payload) || payload.length !== texts.length) {
    throw new Error('Edge translate payload size mismatch');
  }
  return payload.map((item) => {
    const first = Array.isArray(item?.translations) ? item.translations[0] : null;
    const translated = typeof first?.text === 'string' ? first.text.trim() : '';
    return translated || '';
  });
}

async function translateTextsToZh(texts) {
  const unique = [...new Set(texts.filter((text) => text && !isMostlyCjk(text)))];
  const token = await getEdgeTranslateToken();
  const result = new Map();
  const chunkSize = 25;

  for (let i = 0; i < unique.length; i += chunkSize) {
    const chunk = unique.slice(i, i + chunkSize);
    let translated = [];
    let lastError;
    for (let retry = 0; retry < 3; retry += 1) {
      try {
        translated = await translateBatchWithEdge(token, chunk);
        lastError = undefined;
        break;
      } catch (error) {
        lastError = error;
        await new Promise((resolveDelay) => setTimeout(resolveDelay, 300 * (retry + 1)));
      }
    }
    if (lastError) {
      throw lastError;
    }
    for (let j = 0; j < chunk.length; j += 1) {
      const source = chunk[j];
      const target = translated[j] || source;
      result.set(source, target);
    }
  }

  return result;
}

function readJsonIfExists(path) {
  if (!existsSync(path)) {
    return {};
  }
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return {};
  }
}

function readFrontmatterField(content, field) {
  const match = content.match(/^---\n([\s\S]*?)\n---\n?/);
  if (!match) {
    return '';
  }
  const frontmatter = match[1];
  const pattern = new RegExp(`^${field}:\\s*(.+)$`, 'mi');
  const fieldMatch = frontmatter.match(pattern);
  return fieldMatch ? fieldMatch[1].trim() : '';
}

function readCatalogSourcePathMap(catalogPath) {
  const catalog = readJsonIfExists(catalogPath);
  if (!Array.isArray(catalog?.templates)) {
    return new Map();
  }
  const map = new Map();
  for (const item of catalog.templates) {
    if (!item || typeof item !== 'object') {
      continue;
    }
    const id = typeof item.id === 'string' ? item.id.trim() : '';
    const sourcePath = typeof item.sourcePath === 'string' ? item.sourcePath.trim() : '';
    if (!id || !sourcePath) {
      continue;
    }
    map.set(id, sourcePath);
  }
  return map;
}

function resolveTemplateBaseData(templateRoot) {
  const entries = readdirSync(templateRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort((a, b) => a.localeCompare(b));

  const result = [];
  for (const id of entries) {
    const templateDir = join(templateRoot, id);
    const files = TEMPLATE_REQUIRED_FILES.filter((fileName) => existsSync(join(templateDir, fileName)));
    if (files.length === 0) {
      continue;
    }
    const identityPath = join(templateDir, 'IDENTITY.md');
    const agentsPath = join(templateDir, 'AGENTS.md');
    const identityContent = existsSync(identityPath) ? readFileSync(identityPath, 'utf8') : '';
    const agentsContent = existsSync(agentsPath) ? readFileSync(agentsPath, 'utf8') : '';
    const fallbackName = toDisplayNameFromSlug(id) || id;
    const identity = parseIdentityMetadata(identityContent, fallbackName);
    const summary = (identity.summary ?? getFirstBodyLine(agentsContent) ?? '').trim();
    result.push({
      id,
      name: (identity.name || fallbackName).trim(),
      summary,
    });
  }
  return result;
}

function resolveZhEntryFromAgencyRepo(agencyRepoRoot, sourcePath) {
  const absolutePath = join(agencyRepoRoot, sourcePath);
  if (!existsSync(absolutePath)) {
    return null;
  }
  const content = readFileSync(absolutePath, 'utf8');
  const name = readFrontmatterField(content, 'name');
  const summary = readFrontmatterField(content, 'description');
  if (!name && !summary) {
    return null;
  }
  return {
    ...(name ? { name } : {}),
    ...(summary ? { summary } : {}),
  };
}

async function buildZhTemplateEntries(baseEntries, existingZh, sourcePathByTemplateId, agencyRepoRoot) {
  const needTranslate = [];
  for (const entry of baseEntries) {
    const sourcePath = sourcePathByTemplateId.get(entry.id);
    const fromAgency = sourcePath ? resolveZhEntryFromAgencyRepo(agencyRepoRoot, sourcePath) : null;
    const existing = existingZh?.templates?.[entry.id];
    const nameSource =
      typeof fromAgency?.name === 'string' && fromAgency.name.trim()
        ? fromAgency.name.trim()
        : typeof existing?.name === 'string' && existing.name.trim()
          ? existing.name.trim()
          : entry.name;
    const summarySource =
      typeof fromAgency?.summary === 'string' && fromAgency.summary.trim()
        ? fromAgency.summary.trim()
        : typeof existing?.summary === 'string' && existing.summary.trim()
          ? existing.summary.trim()
          : entry.summary;
    if (nameSource && !isMostlyCjk(nameSource)) {
      needTranslate.push(nameSource);
    }
    if (summarySource && !isMostlyCjk(summarySource)) {
      needTranslate.push(summarySource);
    }
  }

  const translatedMap = await translateTextsToZh(needTranslate);
  const translatedById = {};

  for (const entry of baseEntries) {
    const sourcePath = sourcePathByTemplateId.get(entry.id);
    const fromAgency = sourcePath ? resolveZhEntryFromAgencyRepo(agencyRepoRoot, sourcePath) : null;
    const existing = existingZh?.templates?.[entry.id];

    const nameSource =
      typeof fromAgency?.name === 'string' && fromAgency.name.trim()
        ? fromAgency.name.trim()
        : typeof existing?.name === 'string' && existing.name.trim()
          ? existing.name.trim()
          : entry.name;
    const summarySource =
      typeof fromAgency?.summary === 'string' && fromAgency.summary.trim()
        ? fromAgency.summary.trim()
        : typeof existing?.summary === 'string' && existing.summary.trim()
          ? existing.summary.trim()
          : entry.summary;

    const translatedName = isMostlyCjk(nameSource) ? nameSource : translatedMap.get(nameSource) || nameSource;
    const translatedSummary = summarySource
      ? isMostlyCjk(summarySource)
        ? summarySource
        : translatedMap.get(summarySource) || summarySource
      : '';

    translatedById[entry.id] = {
      name: translatedName,
      summary: translatedSummary,
    };
  }

  return translatedById;
}

async function main() {
  const projectRoot = resolve(process.cwd());
  const templateRoot = resolve(projectRoot, 'src/features/subagents/templates');
  const catalogPath = resolve(templateRoot, 'catalog.json');
  const agencyZhRoot = process.env.MATCHACLAW_AGENCY_AGENTS_ZH_DIR
    ? resolve(process.env.MATCHACLAW_AGENCY_AGENTS_ZH_DIR)
    : resolve(projectRoot, '../_tmp_agency_agents_zh');
  const localeEnPath = resolve(projectRoot, 'src/i18n/locales/en/subagent-templates.json');
  const localeZhPath = resolve(projectRoot, 'src/i18n/locales/zh/subagent-templates.json');
  const localeJaPath = resolve(projectRoot, 'src/i18n/locales/ja/subagent-templates.json');

  const baseEntries = resolveTemplateBaseData(templateRoot);
  const sourcePathByTemplateId = readCatalogSourcePathMap(catalogPath);
  const existingZh = readJsonIfExists(localeZhPath);

  const enPayload = {
    templates: Object.fromEntries(
      baseEntries.map((entry) => [
        entry.id,
        {
          name: entry.name,
          summary: entry.summary,
        },
      ]),
    ),
  };

  const zhPayload = {
    templates: await buildZhTemplateEntries(baseEntries, existingZh, sourcePathByTemplateId, agencyZhRoot),
  };

  const jaPayload = {
    templates: Object.fromEntries(
      baseEntries.map((entry) => [
        entry.id,
        {
          name: entry.name,
          summary: entry.summary,
        },
      ]),
    ),
  };

  writeFileSync(localeEnPath, `${JSON.stringify(enPayload, null, 2)}\n`, 'utf8');
  writeFileSync(localeZhPath, `${JSON.stringify(zhPayload, null, 2)}\n`, 'utf8');
  writeFileSync(localeJaPath, `${JSON.stringify(jaPayload, null, 2)}\n`, 'utf8');

  let fromAgencyCount = 0;
  for (const entry of baseEntries) {
    const sourcePath = sourcePathByTemplateId.get(entry.id);
    if (!sourcePath) {
      continue;
    }
    const agencyEntry = resolveZhEntryFromAgencyRepo(agencyZhRoot, sourcePath);
    if (agencyEntry?.summary || agencyEntry?.name) {
      fromAgencyCount += 1;
    }
  }

  process.stdout.write(
    `Generated template i18n entries: ${baseEntries.length}\nZH from agency-agents-zh: ${fromAgencyCount}\nEN: ${localeEnPath}\nZH: ${localeZhPath}\nJA: ${localeJaPath}\n`,
  );
}

main();
