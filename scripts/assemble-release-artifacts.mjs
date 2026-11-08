#!/usr/bin/env node

import { createHash } from 'node:crypto';
import { constants, createReadStream } from 'node:fs';
import { copyFile, lstat, mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse, stringify } from 'yaml';

const packageName = /^[^/\\:?#%\x00-\x1f\x7f]+\.(exe|zip|dmg)$/;
const evidenceName = /^runtime-host-package-evidence-[^/\\:?#%\x00-\x1f\x7f]+\.json$/;
const channelName = /^[a-zA-Z0-9][a-zA-Z0-9._-]*\.yml$/;
const architectures = ['x64', 'arm64'];

async function checksum(path) {
  const hash = createHash('sha512');
  let size = 0;
  for await (const chunk of createReadStream(path)) {
    size += chunk.length;
    hash.update(chunk);
  }
  return { size, sha512: hash.digest('base64') };
}

function validateChannel(platform, arch, name, info) {
  const label = `${platform}/${arch}/${name}`;
  const extensions = platform === 'mac' ? ['dmg', 'zip'] : ['exe'];
  if (!info || typeof info.version !== 'string' || !info.version.trim() || !Array.isArray(info.files) || info.packages !== undefined) {
    throw new Error(`${label}: expected builder channel metadata with version and files, not web-installer packages.`);
  }
  if (info.files.length !== extensions.length) {
    throw new Error(`${label}: expected exactly one ${arch} file for each of: ${extensions.join(', ')}.`);
  }
  for (const file of info.files) {
    if (!file || typeof file.url !== 'string' || !packageName.test(file.url) || typeof file.sha512 !== 'string' || !file.sha512) {
      throw new Error(`${label}: files entries require a relative package filename and SHA-512.`);
    }
    if (file.size !== undefined && (!Number.isSafeInteger(file.size) || file.size <= 0)) {
      throw new Error(`${label}: invalid size for ${file.url}.`);
    }
  }
  for (const extension of extensions) {
    if (info.files.filter(file => file.url.endsWith(`-${platform}-${arch}.${extension}`)).length !== 1) {
      throw new Error(`${label}: expected exactly one ${arch} ${extension}.`);
    }
  }
  const primaryFile = info.files.find(file => file.url === info.path);
  if (!primaryFile || primaryFile.sha512 !== info.sha512) {
    throw new Error(`${label}: top-level path/SHA-512 must reference an entry in files.`);
  }
  if (info.size !== undefined && (!Number.isSafeInteger(info.size) || info.size <= 0)) {
    throw new Error(`${label}: invalid top-level size.`);
  }
}

export function mergeChannelInfo(platform, name, x64, arm64) {
  if (platform !== 'mac' && platform !== 'win') throw new Error(`Unsupported release platform: ${platform}`);
  validateChannel(platform, 'x64', name, x64);
  validateChannel(platform, 'arm64', name, arm64);
  if (x64.version !== arm64.version) throw new Error(`${platform}/${name}: architecture channel versions do not match.`);
  // Builder keeps the first task's legacy references; preserve the established per-platform primary.
  const [primary, secondary] = platform === 'mac' ? [arm64, x64] : [x64, arm64];
  const merged = { ...primary, files: [...primary.files, ...secondary.files] };
  if (!merged.files.some(file => file.url === merged.path && file.sha512 === merged.sha512)) {
    throw new Error(`${platform}/${name}: primary top-level reference is missing from merged files.`);
  }
  return merged;
}

async function readArtifact(directory, releaseFiles, includeChannels) {
  if (!(await lstat(directory)).isDirectory()) throw new Error(`Expected an artifact directory: ${directory}`);
  const packages = new Map();
  const channels = new Map();
  for (const name of (await readdir(directory)).sort()) {
    const isPackage = /\.(exe|zip|dmg)$/.test(name);
    const isEvidence = name.startsWith('runtime-host-package-evidence-') && name.endsWith('.json');
    const isChannel = includeChannels && name.endsWith('.yml') && !name.startsWith('builder-');
    if (!isPackage && !isEvidence && !isChannel) continue;
    if ((isPackage && !packageName.test(name)) || (isEvidence && !evidenceName.test(name)) || (isChannel && !channelName.test(name))) {
      throw new Error(`${directory}: unsafe release filename: ${name}`);
    }
    const path = join(directory, name);
    const stat = await lstat(path);
    if (!stat.isFile() || !Number.isSafeInteger(stat.size) || stat.size <= 0) {
      throw new Error(`Expected a nonempty regular release file: ${path}`);
    }
    if (isChannel) {
      if (stat.size > 1024 * 1024) throw new Error(`Channel YAML exceeds 1 MiB: ${path}`);
      try {
        channels.set(name, parse(await readFile(path, 'utf8')));
      } catch (error) {
        throw new Error(`Invalid channel YAML: ${path}: ${error.message}`, { cause: error });
      }
      continue;
    }
    const file = { name, path, ...await checksum(path) };
    const existing = releaseFiles.get(name);
    if (existing && (existing.size !== file.size || existing.sha512 !== file.sha512)) {
      throw new Error(`Conflicting release artifact ${name}: ${existing.path} and ${path}`);
    }
    if (!existing) releaseFiles.set(name, file);
    if (isPackage) packages.set(name, file);
  }
  return { packages, channels };
}

function validatePackageReferences(label, info, packages) {
  for (const reference of info.files) {
    const file = packages.get(reference.url);
    if (!file) throw new Error(`${label}: package must exist in its artifact root: ${reference.url}`);
    if (reference.sha512 !== file.sha512) throw new Error(`${label}: SHA-512 mismatch for ${file.name}.`);
    // Non-differential NSIS may omit size; never manufacture or replace builder metadata.
    if (reference.size !== undefined && reference.size !== file.size) throw new Error(`${label}: size mismatch for ${file.name}.`);
  }
  const primaryFile = packages.get(info.path);
  if (info.size !== undefined && info.size !== primaryFile.size) throw new Error(`${label}: top-level size mismatch for ${info.path}.`);
}

export async function assembleReleaseArtifacts(artifactsRoot, outputDir) {
  const root = resolve(artifactsRoot);
  const output = resolve(outputDir);
  const artifactNames = new Set(await readdir(root));
  const releaseFiles = new Map();
  const mergedChannels = new Map();
  for (const platform of ['mac', 'win']) {
    const directories = architectures.map(arch => `release-${platform}-${arch}`);
    if (!directories.some(name => artifactNames.has(name))) continue;
    if (!directories.every(name => artifactNames.has(name))) {
      throw new Error(`${platform}: both architecture artifacts are required: ${directories.join(', ')}`);
    }
    const [x64, arm64] = await Promise.all(directories.map(name => readArtifact(join(root, name), releaseFiles, true)));
    const channelNames = [...x64.channels.keys()];
    if (!channelNames.length || channelNames.length !== arm64.channels.size || !channelNames.every(name => arm64.channels.has(name))) {
      throw new Error(`${platform}: architecture channel sets must be nonempty and identical.`);
    }
    for (const name of channelNames) {
      if (mergedChannels.has(name)) throw new Error(`Different platforms use the same channel filename: ${name}; refusing to overwrite.`);
      const info = mergeChannelInfo(platform, name, x64.channels.get(name), arm64.channels.get(name));
      for (const [index, artifact] of [x64, arm64].entries()) {
        validatePackageReferences(`${directories[index]}/${name}`, artifact.channels.get(name), artifact.packages);
      }
      mergedChannels.set(name, stringify(info));
    }
  }
  if (!mergedChannels.size) throw new Error('No complete macOS or Windows release artifacts found.');
  const evidenceDirectory = 'release-package-evidence-windows-arm64';
  if (artifactNames.has(evidenceDirectory)) await readArtifact(join(root, evidenceDirectory), releaseFiles, false);

  // Validate the entire bundle before creating anything; existing output is never reused or removed.
  try {
    await mkdir(output);
  } catch (error) {
    if (error.code === 'EEXIST') throw new Error(`Output already exists; choose a new directory: ${output}`, { cause: error });
    throw error;
  }
  for (const file of releaseFiles.values()) await copyFile(file.path, join(output, file.name), constants.COPYFILE_EXCL);
  for (const [name, body] of mergedChannels) await writeFile(join(output, name), body, { flag: 'wx' });
  return { files: releaseFiles.size, channels: mergedChannels.size };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  Promise.resolve().then(() => {
    if (args.length !== 2) throw new Error('Usage: node scripts/assemble-release-artifacts.mjs <artifactsRoot> <outputDir>');
    return assembleReleaseArtifacts(...args);
  }).then(({ files, channels }) => {
    console.log(`[release-assembly] assembled ${files} packages/evidence files and ${channels} channel files.`);
  }).catch(error => {
    console.error(`[release-assembly] ${error.message}`);
    process.exitCode = 1;
  });
}
