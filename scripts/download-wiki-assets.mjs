#!/usr/bin/env node

import { createWriteStream, existsSync, statSync } from 'node:fs';
import { copyFile, mkdir, mkdtemp, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { fileURLToPath } from 'node:url';

export const wikiRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../resources/wiki');
const modelId = 'Xenova/all-MiniLM-L6-v2';
const revision = '751bff37182d3f1213fa05d7196b954e230abad9';
const modelBase = `https://huggingface.co/${modelId}/resolve/${revision}`;
const modelFiles = ['config.json', 'tokenizer.json', 'tokenizer_config.json', 'onnx/model.onnx'];
const notices = ['MINILM-LICENSE.txt', 'ONNXRUNTIME-LICENSE.txt', 'ONNXRUNTIME-ThirdPartyNotices.txt'];
const libraries = {
  win32: ['onnxruntime.dll', 'DirectML.dll', 'dxcompiler.dll', 'dxil.dll'],
  linux: ['libonnxruntime.so.1'],
  darwin: ['libonnxruntime.1.24.3.dylib'],
};
const targets = ['win32/x64', 'win32/arm64', 'linux/x64', 'linux/arm64', 'darwin/arm64'];

function wikiAssetFiles(platform, arch) {
  const target = `${platform}/${arch}`;
  if (!targets.includes(target) && target !== 'darwin/x64') throw new Error(`Wiki local MiniLM does not support ${target}`);
  return [
    ...modelFiles.map(file => `models/${modelId}/${file}`),
    ...notices,
    ...(target === 'darwin/x64' ? [] : libraries[platform].map(file => `onnxruntime/${target}/${file}`)),
  ];
}

function isNonemptyFile(file) {
  return existsSync(file) && statSync(file).isFile() && statSync(file).size > 0;
}

export function checkWikiAssets(root = wikiRoot, platform = process.platform, arch = process.arch) {
  const missing = wikiAssetFiles(platform, arch).filter(file => !isNonemptyFile(join(root, file)));
  if (missing.length) throw new Error(`Wiki assets missing or empty: ${missing.join(', ')}. Run pnpm run download:wiki-assets -- --platform ${platform} --arch ${arch} explicitly.`);
  if (platform === 'darwin' && arch === 'x64') console.warn('[wiki-assets] darwin/x64 has no ONNX Runtime 1.24.3 library; local MiniLM is unavailable.');
}

async function fetchResponse(url) {
  const response = await fetch(url, { signal: AbortSignal.timeout(300_000) });
  if (!response.ok) throw new Error(`Wiki asset download failed (${response.status}): ${url}`);
  return response;
}

async function downloadFile(url, destination) {
  if (isNonemptyFile(destination)) return;
  await mkdir(dirname(destination), { recursive: true });
  const partial = `${destination}.part`;
  try {
    const response = await fetchResponse(url);
    await pipeline(Readable.fromWeb(response.body), createWriteStream(partial));
    await rename(partial, destination);
  } finally {
    await rm(partial, { force: true });
  }
}

async function downloadAssets(selectedTargets) {
  for (const file of modelFiles) await downloadFile(`${modelBase}/${file}`, join(wikiRoot, 'models', modelId, file));
  const licenseSources = [
    ['UKPLab/sentence-transformers', 'v2.2.2', 'LICENSE', notices[0]],
    ['microsoft/onnxruntime', 'v1.24.3', 'LICENSE', notices[1]],
    ['microsoft/onnxruntime', 'v1.24.3', 'ThirdPartyNotices.txt', notices[2]],
  ];
  for (const [repo, ref, file, notice] of licenseSources) {
    const destination = join(wikiRoot, notice);
    if (isNonemptyFile(destination)) continue;
    const response = await fetchResponse(`https://api.github.com/repos/${repo}/contents/${file}?ref=${ref}`);
    const data = await response.json();
    if (data.encoding !== 'base64' || !data.content) throw new Error(`Invalid official license response: ${repo}/${file}`);
    await writeFile(destination, Buffer.from(data.content, 'base64'));
  }
  await downloadFile(`${modelBase}/README.md`, join(wikiRoot, 'MINILM-MODEL-CARD.md'));
  const runtimeFiles = selectedTargets.flatMap(target => {
    const [platform, arch] = target.split('/');
    return wikiAssetFiles(platform, arch).filter(file => file.startsWith('onnxruntime/'));
  });
  if (runtimeFiles.some(file => !isNonemptyFile(join(wikiRoot, file)))) {
    const staging = await mkdtemp(join(tmpdir(), 'matcha-wiki-assets-'));
    try {
      const archive = join(staging, 'onnxruntime-node-1.24.3.tgz');
      await downloadFile('https://registry.npmjs.org/onnxruntime-node/-/onnxruntime-node-1.24.3.tgz', archive);
      const { default: tar } = await import('tar');
      const entries = runtimeFiles.map(file => file.replace('onnxruntime/', 'package/bin/napi-v6/'));
      await tar.x({ file: archive, cwd: staging, filter: file => entries.includes(file) });
      for (const file of runtimeFiles) {
        const destination = join(wikiRoot, file);
        if (isNonemptyFile(destination)) continue;
        await mkdir(dirname(destination), { recursive: true });
        await copyFile(join(staging, file.replace('onnxruntime/', 'package/bin/napi-v6/')), destination);
      }
    } finally {
      await rm(staging, { recursive: true, force: true });
    }
  }
}

async function main() {
  const args = process.argv.slice(2);
  const value = flag => args.includes(flag) ? args[args.indexOf(flag) + 1] : undefined;
  const selectedTargets = args.includes('--all') ? targets : [`${value('--platform') ?? process.platform}/${value('--arch') ?? process.arch}`];
  for (const target of selectedTargets) wikiAssetFiles(...target.split('/'));
  if (!args.includes('--check')) await downloadAssets(selectedTargets);
  for (const target of selectedTargets) checkWikiAssets(wikiRoot, ...target.split('/'));
  console.log(`[wiki-assets] ready: ${selectedTargets.join(', ')} (${wikiRoot})`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => { console.error(`[wiki-assets] ${error.message}`); process.exitCode = 1; });
}
