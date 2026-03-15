#!/usr/bin/env zx

import 'zx/globals';
import { readFileSync, existsSync, mkdirSync, rmSync, cpSync, writeFileSync } from 'node:fs';
import { join, dirname, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const MANIFEST_PATH = join(ROOT, 'resources', 'skills', 'preinstalled-manifest.json');
const OUTPUT_ROOT = join(ROOT, 'build', 'preinstalled-skills');
const TMP_ROOT = join(ROOT, 'build', '.tmp-preinstalled-skills');
$.cwd = ROOT;
$.env.GIT_TERMINAL_PROMPT = '0';

const GIT_RETRY_MAX = Number.parseInt(process.env.PREINSTALL_GIT_RETRY ?? '3', 10);
const GIT_RETRY_DELAY_MS = Number.parseInt(process.env.PREINSTALL_GIT_RETRY_DELAY_MS ?? '2000', 10);

function parsePositiveInt(value, fallback) {
  if (Number.isFinite(value) && value > 0) return Math.floor(value);
  return fallback;
}

const RETRY_MAX = parsePositiveInt(GIT_RETRY_MAX, 3);
const RETRY_DELAY_MS = parsePositiveInt(GIT_RETRY_DELAY_MS, 2000);

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function runWithRetry(label, action) {
  let lastError = null;
  for (let attempt = 1; attempt <= RETRY_MAX; attempt += 1) {
    try {
      return await action();
    } catch (error) {
      lastError = error;
      if (attempt >= RETRY_MAX) break;
      const backoffMs = RETRY_DELAY_MS * (2 ** (attempt - 1));
      echo`⚠️ ${label} failed (attempt ${attempt}/${RETRY_MAX}): ${error.message || String(error)}`;
      echo`   retrying in ${backoffMs}ms...`;
      await sleep(backoffMs);
    }
  }
  throw new Error(`${label} failed after ${RETRY_MAX} attempts: ${lastError?.message || String(lastError)}`);
}

function loadManifest() {
  if (!existsSync(MANIFEST_PATH)) {
    throw new Error(`Missing manifest: ${MANIFEST_PATH}`);
  }
  const raw = readFileSync(MANIFEST_PATH, 'utf8');
  const parsed = JSON.parse(raw);
  if (!parsed || !Array.isArray(parsed.skills)) {
    throw new Error('Invalid preinstalled-skills manifest format');
  }
  for (const item of parsed.skills) {
    const hasRepoSource = Boolean(item.repo && item.repoPath);
    const hasUrlSource = Boolean(item.sourceUrl);
    if (!item.slug || (!hasRepoSource && !hasUrlSource)) {
      throw new Error(`Invalid manifest entry: ${JSON.stringify(item)}`);
    }
  }
  return parsed.skills;
}

function groupByRepoRef(entries) {
  const grouped = new Map();
  for (const entry of entries) {
    if (!entry.repo || !entry.repoPath) {
      continue;
    }
    const ref = entry.ref || 'main';
    const key = `${entry.repo}#${ref}`;
    if (!grouped.has(key)) grouped.set(key, { repo: entry.repo, ref, entries: [] });
    grouped.get(key).entries.push(entry);
  }
  return [...grouped.values()];
}

function createRepoDirName(repo, ref) {
  return `${repo.replace(/[\\/]/g, '__')}__${ref.replace(/[^a-zA-Z0-9._-]/g, '_')}`;
}

function toShellPath(path) {
  return path.replaceAll('\\', '/');
}

async function fetchSkillFromUrl(sourceUrl) {
  const response = await fetch(sourceUrl, {
    headers: {
      'User-Agent': 'MatchaClaw-preinstalled-skills-bundler',
      Accept: 'text/plain, text/markdown, */*',
    },
  });
  if (!response.ok) {
    throw new Error(`HTTP ${response.status} ${response.statusText}`);
  }
  const content = await response.text();
  const normalized = content.replace(/^\uFEFF/, '');
  if (!normalized.trim()) {
    throw new Error('Downloaded skill content is empty');
  }
  return normalized;
}

function hashSkillContent(content) {
  return createHash('sha256').update(content, 'utf8').digest('hex');
}

async function fetchRepoSnapshot(repo, ref, paths, checkoutDir) {
  const remote = `https://github.com/${repo}.git`;
  const relativeCheckoutDir = relative(ROOT, checkoutDir);
  const checkoutShellPath = toShellPath(relativeCheckoutDir || '.');

  await runWithRetry(`git clone ${repo}@${ref}`, async () => {
    rmSync(checkoutDir, { recursive: true, force: true });
    await $`git clone --depth 1 --filter=blob:none --no-checkout --branch ${ref} ${remote} ${checkoutShellPath}`;
  });

  await runWithRetry(`git sparse-checkout init ${repo}@${ref}`, async () => {
    await $`git -C ${checkoutShellPath} sparse-checkout init --no-cone`;
  });

  for (const repoPath of paths) {
    await runWithRetry(`git sparse-checkout add ${repoPath} (${repo}@${ref})`, async () => {
      await $`git -C ${checkoutShellPath} sparse-checkout add ${repoPath}`;
    });
  }

  await runWithRetry(`git checkout ${repo}@${ref}`, async () => {
    await $`git -C ${checkoutShellPath} checkout ${ref}`;
  });

  const commit = (await $`git -C ${checkoutShellPath} rev-parse HEAD`).stdout.trim();
  return commit;
}

echo`Bundling preinstalled skills...`;
const manifestSkills = loadManifest();

rmSync(OUTPUT_ROOT, { recursive: true, force: true });
mkdirSync(OUTPUT_ROOT, { recursive: true });
rmSync(TMP_ROOT, { recursive: true, force: true });
mkdirSync(TMP_ROOT, { recursive: true });

const lock = {
  generatedAt: new Date().toISOString(),
  skills: [],
};

const repoBackedSkills = manifestSkills.filter((entry) => entry.repo && entry.repoPath);
const urlBackedSkills = manifestSkills.filter((entry) => entry.sourceUrl);

const groups = groupByRepoRef(repoBackedSkills);
for (const group of groups) {
  const repoDir = join(TMP_ROOT, createRepoDirName(group.repo, group.ref));
  const sparsePaths = [...new Set(group.entries.map((entry) => entry.repoPath))];

  echo`Fetching ${group.repo} @ ${group.ref}`;
  const commit = await fetchRepoSnapshot(group.repo, group.ref, sparsePaths, repoDir);
  echo`   commit ${commit}`;

  for (const entry of group.entries) {
    const sourceDir = join(repoDir, entry.repoPath);
    const targetDir = join(OUTPUT_ROOT, entry.slug);

    if (!existsSync(sourceDir)) {
      throw new Error(`Missing source path in repo checkout: ${entry.repoPath} (repo=${entry.repo}, ref=${entry.ref || 'main'})`);
    }

    rmSync(targetDir, { recursive: true, force: true });
    cpSync(sourceDir, targetDir, { recursive: true, dereference: true });

    const skillManifest = join(targetDir, 'SKILL.md');
    if (!existsSync(skillManifest)) {
      throw new Error(`Skill ${entry.slug} is missing SKILL.md after copy`);
    }

    const requestedVersion = (entry.version || '').trim();
    const resolvedVersion = !requestedVersion || requestedVersion === 'main'
      ? commit
      : requestedVersion;
    lock.skills.push({
      slug: entry.slug,
      version: resolvedVersion,
      repo: entry.repo,
      repoPath: entry.repoPath,
      ref: group.ref,
      commit,
    });

    echo`   OK ${entry.slug}`;
  }
}

for (const entry of urlBackedSkills) {
  const targetDir = join(OUTPUT_ROOT, entry.slug);
  echo`Fetching ${entry.sourceUrl} -> ${entry.slug}`;
  const content = await runWithRetry(`download ${entry.slug}`, async () => fetchSkillFromUrl(entry.sourceUrl));

  rmSync(targetDir, { recursive: true, force: true });
  mkdirSync(targetDir, { recursive: true });
  writeFileSync(join(targetDir, 'SKILL.md'), content, 'utf8');

  const contentHash = hashSkillContent(content);
  const requestedVersion = (entry.version || '').trim();
  const resolvedVersion = !requestedVersion || requestedVersion === 'main'
    ? `url-${contentHash.slice(0, 12)}`
    : requestedVersion;

  lock.skills.push({
    slug: entry.slug,
    version: resolvedVersion,
    sourceUrl: entry.sourceUrl,
    ref: 'url',
    commit: contentHash,
  });

  echo`   OK ${entry.slug}`;
}

writeFileSync(join(OUTPUT_ROOT, '.preinstalled-lock.json'), `${JSON.stringify(lock, null, 2)}\n`, 'utf8');
rmSync(TMP_ROOT, { recursive: true, force: true });
echo`Preinstalled skills ready: ${OUTPUT_ROOT}`;
