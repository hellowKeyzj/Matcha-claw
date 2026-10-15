#!/usr/bin/env node

import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { lstat, readFile, readdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { Readable } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { parse } from 'yaml';

const updateRoot = new URL('https://www.senluopan.com/dav/');
const packageName = /^[^/\\:?#%\x00-\x1f\x7f]+\.(exe|zip|dmg)$/;
const channelName = /^[a-zA-Z0-9][a-zA-Z0-9._-]*\.yml$/;
const requestTimeout = 30 * 60 * 1000;

async function checksum(stream, maximumSize = Infinity) {
  const hash = createHash('sha512');
  let size = 0;
  for await (const chunk of stream) {
    size += chunk.length;
    if (size > maximumSize) return { size };
    hash.update(chunk);
  }
  return { size, sha512: hash.digest('base64') };
}

async function preflight(bundleDirectory) {
  const packages = new Map();
  const channels = [];
  const names = (await readdir(bundleDirectory)).sort();
  for (const name of names) {
    if (!packageName.test(name) && (!channelName.test(name) || name.startsWith('builder-'))) continue;
    const path = join(bundleDirectory, name);
    const stat = await lstat(path);
    if (!stat.isFile() || !Number.isSafeInteger(stat.size) || stat.size <= 0) {
      throw new Error(`Expected a nonempty regular release file: ${name}`);
    }
    if (packageName.test(name)) {
      packages.set(name, { name, path, ...await checksum(createReadStream(path)) });
      continue;
    }
    if (stat.size > 1024 * 1024) throw new Error(`Channel YAML exceeds 1 MiB: ${name}`);
    const body = await readFile(path);
    let info;
    try {
      info = parse(body.toString('utf8'));
    } catch {
      throw new Error(`Invalid channel YAML: ${name}`);
    }
    channels.push({ name, body, size: body.length, info });
  }
  if (!packages.size || !channels.length) throw new Error('Deploy bundle must contain packages and builder channel YAML files.');

  function validateReference(name, reference) {
    const file = typeof reference.url === 'string' && packageName.test(reference.url) ? packages.get(reference.url) : undefined;
    if (!file) throw new Error(`${name}: package reference must be an existing relative filename.`);
    if (reference.sha512 !== file.sha512) throw new Error(`${name}: SHA-512 mismatch for ${file.name}.`);
    // Builder omits size for non-differential NSIS; every declared size must still match.
    if (reference.size !== undefined && reference.size !== file.size) throw new Error(`${name}: size mismatch for ${file.name}.`);
  }

  for (const { name, info } of channels) {
    if (!info || typeof info.version !== 'string' || !info.version.trim() || !Array.isArray(info.files) || !info.files.length || info.packages !== undefined) {
      throw new Error(`${name}: expected builder channel metadata with version and files, not config or web-installer packages.`);
    }
    for (const file of info.files) {
      if (!file || typeof file !== 'object') throw new Error(`${name}: invalid files entry.`);
      validateReference(name, file);
    }
    if (info.path !== undefined) validateReference(name, { url: info.path, sha512: info.sha512, size: info.size });
  }
  return { packages: [...packages.values()], channels };
}

async function upload(file, authorization) {
  const body = file.body ?? createReadStream(file.path);
  try {
    const response = await fetch(new URL(encodeURIComponent(file.name), updateRoot), {
      method: 'PUT',
      headers: {
        Authorization: authorization,
        'Content-Length': String(file.size),
        'Content-Type': file.body ? 'application/yaml' : 'application/octet-stream',
      },
      body,
      duplex: 'half',
      redirect: 'manual',
      signal: AbortSignal.timeout(requestTimeout),
    });
    await response.body?.cancel();
    if (!response.ok) throw new Error(`PUT ${file.name}: HTTP ${response.status}; channel publication stopped.`);
  } finally {
    if (!file.body) body.destroy();
  }
  console.log(`[update-webdav] uploaded ${file.name}`);
}

async function download(file, authorization) {
  let url = new URL(encodeURIComponent(file.name), updateRoot);
  const headers = { Authorization: authorization, 'Accept-Encoding': 'identity' };
  const signal = AbortSignal.timeout(requestTimeout);
  for (let redirects = 0; redirects <= 5; redirects += 1) {
    const response = await fetch(url, { headers, redirect: 'manual', cache: 'no-store', signal });
    if (![301, 302, 303, 307, 308].includes(response.status)) return response;
    await response.body?.cancel();
    const location = response.headers.get('location');
    if (!location) throw new Error(`GET ${file.name}: redirect has no Location.`);
    const next = new URL(location, url);
    if (next.protocol !== 'https:' || next.username || next.password) throw new Error(`GET ${file.name}: unsafe download redirect.`);
    // Signed download/CDN redirects must never receive the WebDAV write credential.
    if (next.origin !== url.origin) delete headers.Authorization;
    url = next;
  }
  throw new Error(`GET ${file.name}: too many redirects.`);
}

async function verify(file, authorization) {
  const response = await download(file, authorization);
  if (response.status !== 200 || !response.body) {
    await response.body?.cancel();
    throw new Error(`GET ${file.name}: HTTP ${response.status}; no channel YAML uploaded.`);
  }
  const remote = await checksum(Readable.fromWeb(response.body), file.size);
  if (remote.size !== file.size || remote.sha512 !== file.sha512) {
    throw new Error(`Remote size/SHA-512 verification failed: ${file.name}; no channel YAML uploaded.`);
  }
  console.log(`[update-webdav] verified ${file.name} (${file.size} bytes, SHA-512)`);
}

export async function publishUpdate(bundleDirectory) {
  const username = process.env.UPDATE_WEBDAV_USERNAME;
  const password = process.env.UPDATE_WEBDAV_PASSWORD;
  if (!username || !password) throw new Error('Missing UPDATE_WEBDAV_USERNAME / UPDATE_WEBDAV_PASSWORD; configure both GitHub Secrets.');
  if (username.includes(':')) throw new Error('UPDATE_WEBDAV_USERNAME must not contain a colon.');
  if (process.env.NODE_TLS_REJECT_UNAUTHORIZED === '0') throw new Error('HTTPS certificate verification must remain enabled.');
  const { packages, channels } = await preflight(resolve(bundleDirectory));
  const authorization = `Basic ${Buffer.from(`${username}:${password}`).toString('base64')}`;
  console.log(`[update-webdav] preflight passed: ${packages.length} packages, ${channels.length} channel files.`);
  for (const file of packages) await upload(file, authorization);
  for (const file of packages) await verify(file, authorization);
  for (const file of channels) await upload(file, authorization);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  Promise.resolve().then(() => {
    if (args.length !== 1) throw new Error('Usage: node scripts/publish-update-webdav.mjs <deploy-bundle>');
    return publishUpdate(args[0]);
  }).catch(error => {
    console.error(`[update-webdav] ${error.message}`);
    process.exitCode = 1;
  });
}
