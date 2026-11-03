import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { lstat, mkdir, mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { fileURLToPath } from 'node:url';
import { gunzipSync } from 'node:zlib';
import { unzipSync } from 'fflate';
import { assertDesignNative } from './native.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../build/design-native');
const skia = {
  url: 'https://github.com/samizdatco/skia-canvas/releases/download/v3.0.4/win32-arm64.gz',
  size: 9_915_056,
  digest: '480b9598d5b1d4c1dfd13947f7d5042218851493a79470a59e5b47943941de6c',
};
const ffmpeg = {
  url: 'https://github.com/BtbN/FFmpeg-Builds/releases/download/autobuild-2026-10-31-12-59/ffmpeg-n8.1.3-27-g8dca1586f4-winarm64-gpl-8.1.zip',
  size: 134_963_677,
  digest: '40029da82e02abf0d12491e23666e710b7a8943d13501594cf38e6135b95efba',
};
const vcrt = {
  url: 'https://download.visualstudio.microsoft.com/download/pr/d7450eb5-03e1-436d-9e7e-deb5fe4759b3/5139E1440C3A20B92153A4DB561C069A0175AAF76C276C3E5B6F56099EDCF4B0/VC_redist.arm64.exe',
  size: 11_722_336,
  digest: '5139e1440c3a20b92153a4db561c069a0175aaf76c276c3e5b6f56099edcf4b0',
};
const ffmpegRoot = 'ffmpeg-n8.1.3-27-g8dca1586f4-winarm64-gpl-8.1';
const files = {
  'skia.node': [22_411_264, '8295d302a24e2c89b2b68ffc1deb31e01b5e1c78bdaaa547a261abd41bfa81a6'],
  'ffmpeg.exe': [94_406_144, '0fa09f6cd5582e7a9404312087203f2f921b4020459ddb69ab1669502a03972c'],
  'ffmpeg.exe.LICENSE': [35_147, '8ceb4b9ee5adedde47b31e975c1d90c73ad27b6b165a1dcd80c7c545eb65b903'],
  'msvcp140.dll': [1_372_216, '045faeab0b5710816ae160ea20dae8495ffc11bb51feca15d22aaf7ff3752cb3'],
  'vcruntime140.dll': [199_200, 'd8a8513921544569837e400d37cc71302819967ae6defa932266a7ecb41dbaf9'],
  'vcrt.LICENSE.rtf': [9_235, '8099dc3cf9502c335da829e5c755948a12e3e6de490eb492a99deb673d883d8b'],
};
const provenance = `FFmpeg n8.1.3-27-g8dca1586f4, native Windows ARM64, GPLv3 or later.
Binary archive: ${ffmpeg.url}
Archive SHA256: ${ffmpeg.digest}
Executable SHA256: ${files['ffmpeg.exe'][1]}
FFmpeg source: https://github.com/FFmpeg/FFmpeg/tree/8dca1586f468bfcbb78ae3ed618af1361d9f140a
Build scripts: https://github.com/BtbN/FFmpeg-Builds/tree/5031c6f1082414e53688d39e521849905071070d
Variant: winarm64-gpl + 8.1 (static libraries, libx264, built-in AAC; no nonfree variant).
x264 source: https://code.videolan.org/videolan/x264/-/tree/0480cb05fa188d37ae87e8f4fd8f1aea3711f7ee
Only bin/ffmpeg.exe and LICENSE.txt were selected from the upstream archive.
This file records provenance, not an offer of corresponding source. Distributors must
provide the complete corresponding source and build materials required by GPL,
including linked dependencies; links alone do not satisfy those obligations.
`;

function verify(bytes, size, digest, label) {
  if (bytes.length !== size || createHash('sha256').update(bytes).digest('hex') !== digest) {
    throw new Error(`Design ARM64 ${label} does not match its pinned size and SHA256.`);
  }
  return bytes;
}

async function readPinnedFile(path, size, digest) {
  const info = await lstat(path);
  if (!info.isFile() || info.isSymbolicLink() || info.size !== size) {
    throw new Error(`Design ARM64 input is not the pinned regular file: ${path}.`);
  }
  return verify(await readFile(path), size, digest, path);
}

async function download(artifact, cache) {
  const target = join(cache, artifact.digest);
  const info = await lstat(target).catch((error) => { if (error.code !== 'ENOENT') throw error; });
  if (info) return readPinnedFile(target, artifact.size, artifact.digest);
  // Downloads are data only, isolated from the script and the extracted output.
  const work = await mkdtemp(join(cache, '.download-'));
  try {
    const response = await fetch(artifact.url, { signal: AbortSignal.timeout(180_000) });
    if (!response.ok || !response.body) throw new Error(`Design ARM64 download failed: HTTP ${response.status} ${artifact.url}`);
    let size = 0;
    const bounded = new Transform({
      transform(chunk, _, callback) {
        size += chunk.length;
        callback(size > artifact.size ? new Error('Design ARM64 download exceeds its pinned size.') : null, chunk);
      },
    });
    const file = join(work, 'archive');
    await pipeline(response.body, bounded, createWriteStream(file, { flags: 'wx', mode: 0o600 }));
    const bytes = await readPinnedFile(file, artifact.size, artifact.digest);
    await rename(file, target);
    return bytes;
  } finally {
    await rm(work, { recursive: true, force: true });
  }
}

async function prepareVisualCpp(cache, work, output) {
  const archives = join(work, 'vcrt-archives');
  const extracted = join(work, 'vcrt-extracted');
  await mkdir(archives);
  await mkdir(extracted);
  const bytes = await download(vcrt, cache);
  // Fixed, hash-verified Burn payloads; never execute the redistributable installer.
  for (const [name, offset, size] of [['ux', 479_744, 193_605], ['payload', 683_776, 11_028_159]]) {
    const cabinet = bytes.subarray(offset, offset + size);
    if (cabinet.toString('ascii', 0, 4) !== 'MSCF' || cabinet.readUInt32LE(8) !== size) {
      throw new Error(`Unexpected Visual C++ ${name} cabinet.`);
    }
    await writeFile(join(archives, `${name}.cab`), cabinet, { flag: 'wx' });
  }
  const expand = (source, member, destination) => execFileSync(join(process.env.SystemRoot, 'System32/expand.exe'),
    [source, `-F:${member}`, destination], { stdio: 'pipe', timeout: 30_000 });
  expand(join(archives, 'ux.cab'), 'u4', extracted);
  expand(join(archives, 'payload.cab'), 'a1', extracted);
  const dlls = join(work, 'vcrt-dlls');
  await mkdir(dlls);
  for (const name of ['msvcp140.dll', 'vcruntime140.dll']) {
    expand(join(extracted, 'a1'), `${name}_arm64`, dlls);
    const dll = await readPinnedFile(join(dlls, `${name}_arm64`), ...files[name]);
    assertDesignNative(dll, 'win32', 'arm64', name);
    await writeFile(join(output, name), dll, { flag: 'wx' });
  }
  await writeFile(join(output, 'vcrt.LICENSE.rtf'),
    await readPinnedFile(join(extracted, 'u4'), ...files['vcrt.LICENSE.rtf']), { flag: 'wx' });
  await writeFile(join(output, 'vcrt.README'), `Microsoft Visual C++ 2015-2022 Runtime 14.44.35211.0, native Windows ARM64.
Source: ${vcrt.url}
Archive SHA256: ${vcrt.digest}
Unmodified Microsoft-signed msvcp140.dll and vcruntime140.dll are app-local Skia dependencies.
Only the required DLLs and the original runtime license were extracted; the installer was not run.
Redistribution authority: https://learn.microsoft.com/en-us/visualstudio/releases/2022/redistribution
Redistribution is subject to the distributor's valid Visual Studio license and its Distributable Code terms.
The included runtime EULA is not itself a redistribution grant.
`, { flag: 'wx' });
}

export async function prepareWindowsArm64() {
  if (process.platform !== 'win32') throw new Error('Preparing Windows ARM64 Design dependencies requires Windows expand.exe.');
  await mkdir(root, { recursive: true });
  const cache = join(root, 'downloads');
  await mkdir(cache, { recursive: true });
  const destination = join(root, 'win32-arm64');
  const existing = await lstat(destination).catch((error) => { if (error.code !== 'ENOENT') throw error; });
  if (existing && (!existing.isDirectory() || existing.isSymbolicLink())) {
    throw new Error('Design Windows ARM64 destination must be a real directory.');
  }
  const work = await mkdtemp(join(root, '.prepare-win-arm64-'));
  const output = join(work, 'output');
  try {
    await mkdir(output);
    await prepareVisualCpp(cache, work, output);
    const skiaBytes = gunzipSync(await download(skia, cache), { maxOutputLength: files['skia.node'][0] });
    verify(skiaBytes, ...files['skia.node'], 'skia.node');
    assertDesignNative(skiaBytes, 'win32', 'arm64', 'skia.node');
    await writeFile(join(output, 'skia.node'), skiaBytes, { flag: 'wx' });
    const entries = new Map([
      [`${ffmpegRoot}/bin/ffmpeg.exe`, 'ffmpeg.exe'],
      [`${ffmpegRoot}/LICENSE.txt`, 'ffmpeg.exe.LICENSE'],
    ]);
    const archive = await download(ffmpeg, cache);
    const extracted = unzipSync(archive, { filter: ({ name, originalSize }) => {
      const file = entries.get(name);
      if (!file) return false;
      if (originalSize !== files[file][0]) throw new Error(`Unexpected Design ARM64 archive member size: ${name}.`);
      return true;
    } });
    for (const [entry, name] of entries) {
      const bytes = extracted[entry];
      if (!bytes) throw new Error(`Design ARM64 archive is missing ${entry}.`);
      verify(bytes, ...files[name], name);
      if (name === 'ffmpeg.exe') assertDesignNative(bytes, 'win32', 'arm64', name);
      await writeFile(join(output, name), bytes, { flag: 'wx' });
    }
    await writeFile(join(output, 'ffmpeg.exe.README'), provenance, { flag: 'wx' });
    const backup = join(work, 'previous');
    if (existing) await rename(destination, backup);
    try {
      await rename(output, destination);
    } catch (error) {
      if (existing) await rename(backup, destination);
      throw error;
    }
    console.log(`[design] Prepared pinned native Windows ARM64 Skia 3.0.4, Visual C++ Runtime 14.44.35211.0 and FFmpeg n8.1.3-27-g8dca1586f4 in ${destination}.`);
    return destination;
  } finally {
    await rm(work, { recursive: true, force: true });
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv.length !== 2) throw new Error('Usage: node apps/design/prepare-win-arm64.mjs');
  await prepareWindowsArm64();
}
