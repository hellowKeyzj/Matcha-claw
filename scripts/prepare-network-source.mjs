#!/usr/bin/env node

import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import { dirname, join, posix, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { unzipSync } from 'fflate';
import { t as listTar, x as extractTar } from 'tar';
import rpcPatches from '../network-access/upstream/easytier-rpc.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const sources = [
  ['easytier', 'EasyTier/EasyTier', '8428a89d2dabc94c97d370ec607c6ca142473626', 'tar.gz', '37fb83c61d16e5a1a88354eb96d0caf526748ffd92364ac22ffad09316bb337c'],
  ['http-req', 'EasyTier/http_req', 'b10aa9fc0db3067cc3d2174683a87250b80a1ea9', 'zip', 'fd6fcf6accbc7b868b1e2a61c6704a30747e10d37f5f47c12e38ef513f75cfee'],
  ['service-manager', 'EasyTier/service-manager-rs', '5eb28f7a686858eea4f4933534ed989d3b71dc2a', 'zip', '037e1698d8449b19a1517f6a3e0c6d879efc6f1aa5671dcdadcf7bdbb8756362'],
  ['thunk', 'easytier/thunk', 'cbbeec75a66b7b3cf0824ae890d9d06bcfb9d1f3', 'zip', '0b0f81c9ab794f39727c75d8e6f00fb3e00fbcd85625e899e1f30ed0c557408a'],
  ['windivert', 'EasyTier/windivert-rust', 'adcc56d1550f7b5377ec2b3429f413ee24a77375', 'zip', 'd4c01b03c94bf14e003d7a102810c7f6e970c32bcaad1d565eb4782a539b4392'],
  ['tun', 'EasyTier/rust-tun', '12378839e7985283df0e4fb536b7137230356db5', 'zip', '3aff2879d5b47986b30280689c57cbaabe3c5c37557c8f2a9b156101d5619040'],
  ['smoltcp', 'smoltcp-rs/smoltcp', '0a926767a68bc88d5512afefa7529c5ecdade4ea', 'zip', 'e0b89d06032ff4fcc1a6fd8a850d85d1aca5e90d18f5d65d7d7cf3cd458b24d9'],
  ['kcp', 'EasyTier/kcp-sys', '94964794caaed5d388463137da59b97499619e5f', 'zip', '1227f986725a823044d2ebcf06b38c52095a3eb061bdc843992335390715831f'],
  ['windivert-native', 'EasyTier/WinDivert', 'b90fad29446667c6230accd078e91a77074b7788', 'zip', '730700d09c5f53ac826e6cb7b52d19ce2ae4ae7b9c4af8ecf39415d00821950a'],
  ['kcp-native', 'skywind3000/kcp', '7f9805887b0909c52c825925f123e7a84da37167', 'zip', '7312244d824a8186e2f3ba4ea4de674880404f4dc16cb8e58fb40d46f3ff7bb5'],
];
const digest = bytes => createHash('sha256').update(bytes).digest('hex');

async function archive(source) {
  const [id, repository, revision, format, sha256] = source;
  const cache = join(root, 'build', 'network-archives', sha256);
  const path = join(cache, `source.${format}`);
  try {
    const bytes = await fs.readFile(path);
    if (digest(bytes) !== sha256) throw new Error(`Invalid cached ${id} source`);
    return path;
  } catch (error) { if (error.code !== 'ENOENT') throw error; }
  const temporary = await fs.mkdtemp(join(root, 'build', 'network-archives', 'download-'));
  try {
    const url = `https://codeload.github.com/${repository}/${format === 'zip' ? 'zip' : 'tar.gz'}/${revision}`;
    const response = await fetch(url, { signal: AbortSignal.timeout(120_000) });
    if (!response.ok || !response.body) throw new Error(`Source download failed: ${id} (${response.status})`);
    const chunks = [];
    let size = 0;
    for await (const chunk of response.body) {
      size += chunk.length;
      if (size > 64 * 1024 * 1024) throw new Error(`Source archive too large: ${id}`);
      chunks.push(chunk);
    }
    const bytes = Buffer.concat(chunks, size);
    if (digest(bytes) !== sha256) throw new Error(`Source SHA256 mismatch: ${id}`);
    await fs.writeFile(join(temporary, `source.${format}`), bytes, { flag: 'wx' });
    await fs.rename(temporary, cache);
    return path;
  } finally { await fs.rm(temporary, { recursive: true, force: true }); }
}

function archivePath(name) {
  if (!name || name.includes('\\') || name.startsWith('/') || name.split('/').some(part => part === '..' || part.includes(':'))) {
    throw new Error('Invalid source archive path');
  }
  return name.split('/').slice(1).join('/');
}

async function extract(source, file, destination) {
  await fs.mkdir(destination);
  let count = 0;
  let size = 0;
  if (source[3] === 'zip') {
    const files = unzipSync(await fs.readFile(file), { filter: entry => {
      archivePath(entry.name);
      if (++count > 20_000 || (size += entry.originalSize) > 256 * 1024 * 1024) throw new Error('Source expanded size exceeds limit');
      return !entry.name.endsWith('/');
    } });
    for (const [name, bytes] of Object.entries(files)) {
      const path = join(destination, archivePath(name));
      await fs.mkdir(dirname(path), { recursive: true });
      await fs.writeFile(path, bytes, { flag: 'wx' });
    }
  } else {
    const links = [];
    await listTar({ file, onentry: entry => {
      const path = archivePath(entry.path);
      if (++count > 20_000 || (size += entry.size) > 256 * 1024 * 1024) throw new Error('Source expanded size exceeds limit');
      if (entry.type === 'SymbolicLink') {
        const target = posix.normalize(posix.join(posix.dirname(path), entry.linkpath));
        if (entry.linkpath.startsWith('/') || entry.linkpath.includes('\\') || target.startsWith('../') || target.includes(':')) throw new Error('Source link escapes archive');
        links.push({ path, target });
      } else if (entry.type !== 'File' && entry.type !== 'Directory') throw new Error('Unsupported source archive member');
    } });
    await extractTar({ file, cwd: destination, strip: 1, filter: (_path, entry) => entry.type === 'File' || entry.type === 'Directory' });
    // Materialize verified internal links as regular files, including on Windows.
    for (const link of links) await fs.cp(join(destination, link.target), join(destination, link.path), { recursive: true, errorOnExist: true, force: false });
  }
}

async function hasSameSourceTree(left, right) {
  let previous;
  try { previous = await fs.readdir(right, { withFileTypes: true }); }
  catch (error) { if (error.code === 'ENOENT') return false; throw error; }
  const entries = await fs.readdir(left, { withFileTypes: true });
  if (entries.length !== previous.length) return false;
  const byName = new Map(previous.map(entry => [entry.name, entry]));
  for (const entry of entries) {
    const other = byName.get(entry.name);
    if (!other || entry.isDirectory() !== other.isDirectory() || entry.isFile() !== other.isFile()) return false;
    const source = join(left, entry.name);
    const destination = join(right, entry.name);
    if (entry.isDirectory()) {
      if (!await hasSameSourceTree(source, destination)) return false;
    } else if (!entry.isFile() || !(await fs.readFile(source)).equals(await fs.readFile(destination))) return false;
  }
  return true;
}

export async function prepareNetworkSource() {
  const build = join(root, 'build');
  await fs.mkdir(join(build, 'network-archives'), { recursive: true });
  const staging = await fs.mkdtemp(join(build, '.network-source-'));
  try {
    await Promise.all(sources.map(async source => {
      await extract(source, await archive(source), join(staging, source[0]));
    }));
    for (const [id, path] of [['windivert-native', 'windivert/windivert-sys/vendor'], ['kcp-native', 'kcp/kcp']]) {
      const destination = join(staging, path);
      // GitHub source archives omit submodule contents; only replace their empty placeholders.
      try {
        if ((await fs.readdir(destination)).length !== 0) throw new Error(`Unexpected submodule contents: ${path}`);
        await fs.rmdir(destination);
      } catch (error) { if (error.code !== 'ENOENT') throw error; }
      await fs.rename(join(staging, id), destination);
    }
    const manifest = join(staging, 'easytier', 'easytier', 'Cargo.toml');
    let text = await fs.readFile(manifest, 'utf8');
    const paths = { http_req: 'http-req', 'service-manager': 'service-manager', 'thunk-rs': 'thunk/thunk-rs', windivert: 'windivert/windivert', tun: 'tun', smoltcp: 'smoltcp', 'kcp-sys': 'kcp' };
    for (const [name, path] of Object.entries(paths)) {
      const pattern = new RegExp(`(^${name}\\s*=\\s*\\{)([^}]+)(\\})`, 'm');
      if (!pattern.test(text)) throw new Error(`Missing pinned dependency: ${name}`);
      text = text.replace(pattern, (_match, open, fields, close) => {
        let rewritten = fields.replace(/\b(?:git|rev|branch)\s*=\s*"[^"]*"\s*,?\s*/g, '');
        // Electron requires Windows 10+; do not download legacy Win7 linker shims.
        if (name === 'thunk-rs') rewritten = rewritten.replace(/features\s*=\s*\[\s*"win7",?\s*\]/, 'features = []');
        return `${open} path = "../../${path}", ${rewritten.trim()} ${close}`;
      });
    }
    await fs.writeFile(manifest, text);
    const patchReceipts = [];
    for (const patch of rpcPatches) {
      const path = join(staging, 'easytier', 'easytier', 'src', patch.path);
      const original = await fs.readFile(path);
      if (digest(original) !== patch.inputSha256) throw new Error(`PeerRPC patch input mismatch: ${patch.path}`);
      let patched = original.toString('utf8');
      if (patch.replacement) {
        patched = await fs.readFile(join(root, 'network-access', 'upstream', patch.replacement), 'utf8');
      } else {
        for (const [before, after] of patch.edits) {
          if (patched.split(before).length !== 2) throw new Error(`PeerRPC patch context mismatch: ${patch.path}`);
          patched = patched.replace(before, after);
        }
      }
      const outputSha256 = digest(patched);
      if (outputSha256 !== patch.outputSha256) throw new Error(`PeerRPC patch output mismatch: ${patch.path}`);
      await fs.writeFile(path, patched);
      patchReceipts.push({ path: `easytier/easytier/src/${patch.path}`, inputSha256: patch.inputSha256, outputSha256 });
    }
    await fs.writeFile(join(staging, 'manifest.json'), `${JSON.stringify({
      sources: sources.map(([id, repository, revision, format, sha256]) => ({ id, repository, revision, format, sha256 })),
      changes: { 'easytier/easytier/Cargo.toml': 'Pinned git dependencies resolved to verified local sources; Win7 linker shim disabled for Electron Windows10+' },
      peerRpcPatch: { source: 'EasyTier/EasyTier@8428a89d2dabc94c97d370ec607c6ca142473626', asset: 'network-access/upstream/easytier-rpc.mjs', files: patchReceipts },
      validation: 'Sources prepared, not compiled',
    }, null, 2)}\n`);
    const destination = join(build, 'network-source');
    // Keep verified, unchanged source mtimes so Cargo can reuse the independent build cache.
    if (await hasSameSourceTree(staging, destination)) {
      console.log('[network-source] Fixed sources verified unchanged; compilation not performed');
      return;
    }
    const previous = `${staging}.previous`;
    let replaced = false;
    try { await fs.rename(destination, previous); replaced = true; }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    try {
      for (let attempt = 0; ; attempt++) {
        try { await fs.rename(staging, destination); break; }
        catch (error) {
          if (process.platform !== 'win32' || !['EPERM', 'EACCES'].includes(error.code) || attempt === 3) throw error;
          await delay(100 * (attempt + 1));
        }
      }
    } catch (error) { if (replaced) await fs.rename(previous, destination); throw error; }
    if (replaced) await fs.rm(previous, { recursive: true, force: true });
    console.log('[network-source] Fixed sources prepared; compilation not performed');
  } finally { await fs.rm(staging, { recursive: true, force: true }); }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  prepareNetworkSource().catch(error => { console.error(`[network-source] ${error.message}`); process.exitCode = 1; });
}
