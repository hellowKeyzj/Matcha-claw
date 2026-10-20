import { createHash } from 'node:crypto';
import { execFile, execFileSync } from 'node:child_process';
import { promisify } from 'node:util';
import { cp, mkdir, mkdtemp, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { patchSource } from './searxng-source-patches.mjs';
import { treeDigest } from './searxng-integrity.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const BUILD = path.join(ROOT, 'build');
const OUTPUT = path.join(BUILD, 'searxng');
const SCRIPTS = path.join(ROOT, 'scripts');
const LOCK = path.join(SCRIPTS, 'searxng-wheels.json');
const PIN = JSON.parse(await readFile(path.join(SCRIPTS, 'searxng-source.json'), 'utf8'));
const PLATFORMS = {
  'win32-x64': 'x86_64-pc-windows-msvc',
  'win32-arm64': 'aarch64-pc-windows-msvc',
  'darwin-x64': 'x86_64-apple-darwin',
  'darwin-arm64': 'aarch64-apple-darwin',
  'linux-x64': 'x86_64-manylinux_2_28',
  'linux-arm64': 'aarch64-manylinux_2_28',
};
const host = `${process.platform}-${process.arch}`;
const uv = path.join(ROOT, 'resources', 'bin', host, process.platform === 'win32' ? 'uv.exe' : 'uv');
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const targets = [];
let updateLock = false;
for (let index = 2; index < process.argv.length; index++) {
  const arg = process.argv[index];
  if (arg === '--update-lock') updateLock = true;
  else if (arg === '--target') targets.push(process.argv[++index]);
  else if (arg.startsWith('--target=')) targets.push(arg.slice(9));
  else throw new Error(`Unknown SearXNG build argument: ${arg}`);
}
if (!targets.length) targets.push(host);
for (const target of targets) if (!PLATFORMS[target]) throw new Error(`Unsupported SearXNG target: ${target}`);
if (PIN.upstreamSha !== '2a6fc07be3760543c7b6d1d1bfe62f5765d5d9d6' || PIN.pythonVersion !== '3.12') {
  throw new Error('SearXNG source or Python version does not match the approved build contract');
}
await mkdir(BUILD, { recursive: true });
const work = await mkdtemp(path.join(BUILD, 'searxng-build-'));
const env = {
  ...process.env, UV_CACHE_DIR: path.join(work, 'uv-cache'), UV_PYTHON_DOWNLOADS: 'never',
  UV_NO_CONFIG: '1', TMP: work, TEMP: work, TMPDIR: work,
};
function run(command, args, capture = false) {
  return execFileSync(command, args, {
    cwd: ROOT, env, windowsHide: true, timeout: 1_200_000,
    encoding: capture ? 'utf8' : undefined, stdio: capture ? ['ignore', 'pipe', 'pipe'] : 'inherit',
  });
}
const python = run(uv, ['python', 'find', '3.12', '--no-python-downloads'], true).trim();
if (run(python, ['-I', '-B', '-c', 'import sys; print(".".join(map(str, sys.version_info[:2])))'], true).trim() !== '3.12') {
  throw new Error('SearXNG build requires the existing uv Python 3.12');
}
function prepare(args) {
  return run(python, ['-I', '-B', path.join(SCRIPTS, 'searxng-prepare.py'), ...args], true);
}
async function download(url, sha256, size) {
  const parsed = new URL(url);
  if (parsed.protocol !== 'https:' || !['codeload.github.com', 'files.pythonhosted.org'].includes(parsed.hostname)) {
    throw new Error('SearXNG download origin is not allowed');
  }
  const directory = await mkdtemp(path.join(work, 'download-'));
  const destination = path.join(directory, 'content');
  await promisify(execFile)('curl', ['--fail', '--location', '--silent', '--show-error', '--connect-timeout', '30',
    '--max-time', '600', '--retry', '2', '--proto', '=https', '--max-filesize', '268435456', '--output', destination, url],
  { cwd: ROOT, env, windowsHide: true, timeout: 1_200_000 });
  const bytes = await readFile(destination);
  if (hash(bytes) !== sha256 || (size !== undefined && bytes.length !== size)) {
    throw new Error('SearXNG download checksum or size mismatch');
  }
  return destination;
}
async function sourceArchive() {
  const cache = path.join(BUILD, 'searxng-cache', `${PIN.sha256}.tar.gz`);
  try {
    if (hash(await readFile(cache)) !== PIN.sha256) throw new Error('Cached SearXNG source checksum mismatch');
    return cache;
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  const archive = await download(PIN.url, PIN.sha256);
  await mkdir(path.dirname(cache), { recursive: true });
  await cp(archive, cache);
  return cache;
}
async function resolveLock(source, requirementsHash) {
  const input = path.join(work, 'requirements.in');
  await writeFile(input, `${await readFile(path.join(source, 'requirements.txt'), 'utf8')}\nwaitress==${PIN.waitressVersion}\ntzdata==${PIN.tzdataVersion}\n`);
  const resolved = {};
  for (const [target, platform] of Object.entries(PLATFORMS)) {
    const output = path.join(work, `pylock.${target}.toml`);
    run(uv, ['pip', 'compile', input, '--python', python, '--python-version', PIN.pythonVersion,
      '--python-platform', platform, '--only-binary', ':all:', '--format', 'pylock.toml',
      '--exclude-newer', PIN.excludeNewer, '--output-file', output, '--no-header', '--no-annotate', '--quiet']);
    resolved[target] = JSON.parse(prepare(['describe-lock', '--lock', output]));
    console.log(`[searxng] locked ${target}: ${resolved[target].length} wheels`);
  }
  const lock = { schemaVersion: 1, upstreamSha: PIN.upstreamSha, pythonVersion: PIN.pythonVersion, requirementsHash, targets: resolved };
  await writeFile(LOCK, `${JSON.stringify(lock, null, 2)}\n`);
  return lock;
}
function requirements(lock) {
  const packages = new Map();
  for (const [target, wheels] of Object.entries(lock.targets)) {
    for (const wheel of wheels) {
      const key = `${wheel.name}==${wheel.version}`;
      const entry = packages.get(key) ?? { hashes: new Set(), targets: new Set() };
      entry.hashes.add(wheel.sha256);
      entry.targets.add(target);
      packages.set(key, entry);
    }
  }
  return [...packages].sort(([a], [b]) => a.localeCompare(b)).map(([name, entry]) => {
    const platforms = [...new Set([...entry.targets].map(target => target.split('-')[0]))];
    const marker = entry.targets.size === Object.keys(PLATFORMS).length ? '' : ` ; ${platforms.map(platform => `sys_platform == '${platform}'`).join(' or ')}`;
    return `${name}${marker} \\\n${[...entry.hashes].sort().map(digest => `    --hash=sha256:${digest}`).join(' \\\n')}`;
  }).join('\n') + '\n';
}
try {
  const source = path.join(work, 'source');
  await mkdir(source);
  prepare(['extract', '--archive', await sourceArchive(), '--output', source, '--revision', PIN.upstreamSha]);
  const requirementsHash = hash(await readFile(path.join(source, 'requirements.txt')));
  const lock = updateLock ? await resolveLock(source, requirementsHash) : JSON.parse(await readFile(LOCK, 'utf8'));
  if (lock.schemaVersion !== 1 || lock.upstreamSha !== PIN.upstreamSha || lock.pythonVersion !== '3.12' || lock.requirementsHash !== requirementsHash) {
    throw new Error('SearXNG wheel lock does not match the pinned upstream requirements');
  }
  const changes = await patchSource(source, PIN.upstreamSha, PIN.version);
  const buildScripts = path.join(source, 'matchaclaw-build', 'scripts');
  await mkdir(buildScripts, { recursive: true });
  for (const filename of ['bundle-searxng.mjs', 'searxng-integrity.mjs', 'searxng-source.json', 'searxng-wheels.json', 'searxng-source-patches.mjs', 'searxng-prepare.py', 'searxng-serve.py']) {
    await cp(path.join(SCRIPTS, filename), path.join(buildScripts, filename));
  }
  await writeFile(path.join(source, 'MATCHACLAW-MODIFICATIONS.json'), `${JSON.stringify({
    upstreamSha: PIN.upstreamSha, archive: { url: PIN.url, sha256: PIN.sha256 }, license: 'AGPL-3.0-or-later', changes,
    omitted: 'Development, test, documentation, container and build tooling outside the searx runtime package.',
    build: 'node scripts/bundle-searxng.mjs --target <platform-arch>',
  }, null, 2)}\n`);
  for (const target of new Set(targets)) {
    const wheels = lock.targets[target];
    if (!Array.isArray(wheels) || !wheels.length) throw new Error(`No locked SearXNG wheels for ${target}`);
    const directory = path.join(work, `wheels-${target}`);
    await mkdir(directory);
    const queue = [...wheels];
    async function copyWheel(wheel) {
      const filename = path.posix.basename(new URL(wheel.url).pathname);
      if (!/^[a-zA-Z0-9_.+-]+\.whl$/.test(filename)) throw new Error('Invalid locked wheel filename');
      const cached = path.join(BUILD, 'searxng-cache', 'wheels', wheel.sha256, filename);
      let file = cached;
      try {
        const bytes = await readFile(cached);
        if (hash(bytes) !== wheel.sha256 || bytes.length !== wheel.size) throw new Error('Cached SearXNG wheel checksum mismatch');
      } catch (error) {
        if (error.code !== 'ENOENT') throw error;
        file = await download(wheel.url, wheel.sha256, wheel.size);
        await mkdir(path.dirname(cached), { recursive: true });
        await cp(file, cached);
      }
      await cp(file, path.join(directory, filename));
    }
    const downloads = await Promise.allSettled(Array.from({ length: 4 }, async () => {
      while (queue.length) await copyWheel(queue.shift());
    }));
    for (const download of downloads) if (download.status === 'rejected') throw download.reason;
    await mkdir(path.join(OUTPUT, 'wheels'), { recursive: true });
    await rm(path.join(OUTPUT, 'wheels', target), { recursive: true, force: true });
    await rename(directory, path.join(OUTPUT, 'wheels', target));
    console.log(`[searxng] bundled ${target}: ${wheels.length} hash-verified wheels`);
  }
  await rm(path.join(OUTPUT, 'source'), { recursive: true, force: true });
  await rename(source, path.join(OUTPUT, 'source'));
  await cp(path.join(SCRIPTS, 'searxng-serve.py'), path.join(OUTPUT, 'serve.py'));
  await writeFile(path.join(OUTPUT, 'requirements.lock'), requirements(lock));
  const delivered = {};
  for (const target of Object.keys(PLATFORMS)) {
    const directory = path.join(OUTPUT, 'wheels', target);
    try { await stat(directory); } catch (error) { if (error.code === 'ENOENT') continue; throw error; }
    const expected = lock.targets[target];
    const files = await readdir(directory);
    if (files.length !== expected.length) throw new Error(`SearXNG wheel inventory mismatch for ${target}`);
    for (const wheel of expected) {
      const bytes = await readFile(path.join(directory, path.posix.basename(new URL(wheel.url).pathname)));
      if (hash(bytes) !== wheel.sha256) throw new Error(`SearXNG wheel checksum mismatch for ${target}`);
    }
    delivered[target] = await treeDigest(directory);
  }
  const manifest = {
    schemaVersion: 1, upstreamSha: PIN.upstreamSha, pythonVersion: PIN.pythonVersion,
    archive: { url: PIN.url, sha256: PIN.sha256 }, license: 'AGPL-3.0-or-later',
    source: await treeDigest(path.join(OUTPUT, 'source')),
    requirementsSha256: hash(await readFile(path.join(OUTPUT, 'requirements.lock'))),
    serveSha256: hash(await readFile(path.join(OUTPUT, 'serve.py'))),
    wheelLockSha256: hash(await readFile(LOCK)), targets: delivered, changes,
  };
  await writeFile(path.join(OUTPUT, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  console.log(`[searxng] ${PIN.upstreamSha} ready: ${JSON.stringify(await treeDigest(OUTPUT))}`);
} finally {
  await rm(work, { recursive: true, force: true });
}
