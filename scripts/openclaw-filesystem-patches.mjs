import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';

const PATCH = 'matcha-plugin-capture-no-follow-v1';
const HELPER = 'matcha-safe-delete.mjs';
const HELPER_SHA256 = '0b5df29fa36c0a8d9856852376ea58e3e2bb3221e3211f6ea12ec5c782b17488';
const ORIGINAL = {
  'plugin-source-capture-directory-BQ-mKxVB.mjs': '1b8846900f1a8df2f7410ecf26cf653d6c301c2f85fe9171ae041044a3e649d8',
  'plugin-generation-source-lookup-DoFpdK5E.mjs': 'f590b4e2d917fde3cfc33f4f45423678a1ca169ce9865747e9fec66c47e35361',
  'native-hook-relay/resolve-nOdVQoU9.mjs': 'd0af36e382a7b88ed9bda5f15a406b2c33e70d24f25691d6a01e910e35bdcf48',
};
const WORKER_ORIGINAL = {
  'worker-chunk-CvXFaEh9.mjs': '98cb66a36fb206c6180caf88fe99ef0cde9af80285789c6addee8b14be834be2',
  'worker-chunk-De0GZxJP.mjs': 'd53126bd2991434e62ab83baf3760743cbbbf360be12f20b64d3a01d0e2b545f',
  'sqlite-store.worker.mjs': 'c812411942c6affcf0e6ea4baec5739b2d4268f311b4adde383dba1c54793075',
};
const digest = (source) => createHash('sha256').update(source).digest('hex');

function replace(source, before, after) {
  if (source.split(before).length !== 2) throw new Error(`${PATCH}: expected one source anchor: ${before.slice(0, 100)}`);
  return source.replace(before, after);
}

export function getOpenClawSafeDeleteSource() {
  const source = fs.readFileSync(new URL('./lib/safe-delete.mjs', import.meta.url), 'utf8');
  if (digest(source) !== HELPER_SHA256) throw new Error(`${PATCH}: safe-delete helper source changed`);
  return source;
}

function patchCaptureDirectory(source, fsName, includeNativeRoot) {
  source = replace(source, `${fsName}.rmSync(path.join(root, "captures"), {
		recursive: true,
		force: true
	})`, 'matchaSafeRmSync(path.join(root, "captures"), { root })');
  source = replace(source, `${fsName}.rmSync(directory, {
		recursive: true,
		force: true
	})`, 'matchaSafeRmSync(directory, { root: path.dirname(directory) })');
  source = replace(source, `${fsName}.rmSync(root, {
		recursive: true,
		force: true
	})`, 'matchaSafeRmSync(root, { root: path.dirname(root) })');
  if (includeNativeRoot) source = replace(source, `${fsName}.rmSync(root.directory, {
						recursive: true,
						force: true
					})`, 'matchaSafeRmSync(root.directory, { root: path.dirname(root.directory) })');
  return source;
}

function patchSourceLookup(source) {
  source = replace(source, 'fs.rmSync(created, {\n\t\t\t\trecursive: true,\n\t\t\t\tforce: true\n\t\t\t})', 'matchaSafeRmSync(created, { root: path.dirname(created) })');
  source = replace(source, 'fs.rmSync(directory, {\n\t\t\t\trecursive: true,\n\t\t\t\tforce: true\n\t\t\t})', 'matchaSafeRmSync(directory, { root: path.dirname(directory) })');
  return replace(source, 'fs.rmSync(directory, {\n\t\t\trecursive: true,\n\t\t\tforce: true\n\t\t})', 'matchaSafeRmSync(directory, { root: capturedRoot })');
}

/** The archive owner applies its final whole-file seal after all worker transforms. */
export function patchOpenClawWorkerFilesystemSource(fileName, source) {
  const originalHash = WORKER_ORIGINAL[fileName];
  if (!originalHash) return source;
  const importLine = 'import { safeRmSync as matchaSafeRmSync } from "./worker-chunk-MatchaSafeDelete.mjs";\n';
  if (source.startsWith(importLine)) {
    // Reconstruct the original to reject drift without sealing World-owned changes here.
    const original = transformWorkerFilesystem(fileName, source.slice(importLine.length), true);
    if (digest(original) !== originalHash) throw new Error(`${PATCH}: patched worker source drift: ${fileName}`);
    return source;
  }
  if (digest(source) !== originalHash) throw new Error(`${PATCH}: upstream worker source changed: ${fileName}`);
  return importLine + transformWorkerFilesystem(fileName, source);
}

function transformWorkerFilesystem(fileName, source, reverse = false) {
  const directoryChunk = fileName === 'worker-chunk-CvXFaEh9.mjs';
  const sourceChunk = fileName === 'worker-chunk-De0GZxJP.mjs';
  const edits = [];
  if (!sourceChunk) {
    const fsName = directoryChunk ? 'k' : 'fs';
    const pathName = directoryChunk ? 'j' : 'path';
    const root = directoryChunk ? 'e' : 'Ot';
    const pending = directoryChunk ? 't' : 'Kt';
    const native = directoryChunk ? 'n' : 'Zt';
    const remove = (target) => `${fsName}.rmSync(${target},{recursive:!0,force:!0})`;
    const safe = (target) => `matchaSafeRmSync(${target},{root:${pathName}.dirname(${target})})`;
    const captures = `${pathName}.join(${root},\`captures\`)`;
    edits.push([remove(captures), safe(captures)]);
    edits.push([`for(let ${root} of ${pending})${remove(root)}`, `for(let ${root} of ${pending})${safe(root)}`]);
    edits.push([`(!${fsName}.existsSync(${native})||${fsName}.readdirSync(${native}).length===0)&&${remove(root)}`, `(!${fsName}.existsSync(${native})||${fsName}.readdirSync(${native}).length===0)&&${safe(root)}`]);
    edits.push([remove(`${root}.directory`), safe(`${root}.directory`)]);
  }
  if (!directoryChunk) {
    const fsName = sourceChunk ? 'P' : 'fs';
    const pathName = sourceChunk ? 'F' : 'path';
    const created = sourceChunk ? 'n' : 'Zt';
    const directory = sourceChunk ? 'r' : '_n';
    const content = sourceChunk ? 'm' : 'xr';
    const cleared = sourceChunk ? 'h' : 'Mr';
    const retained = sourceChunk ? 'E' : 'retainLoadedPluginSourceCapture';
    const remove = (target) => `${fsName}.rmSync(${target},{recursive:!0,force:!0})`;
    edits.push([`${created}&&${remove(created)}`, `${created}&&matchaSafeRmSync(${created},{root:${pathName}.dirname(${created})})`]);
    edits.push([`dispose(){beginDisposal(),${retained}(${directory})||${remove(directory)}`, `dispose(){beginDisposal(),${retained}(${directory})||matchaSafeRmSync(${directory},{root:${pathName}.dirname(${directory})})`]);
    edits.push([`${remove(content)},${cleared}.clear()`, `matchaSafeRmSync(${content},{root:${directory}}),${cleared}.clear()`]);
  }
  for (const [before, after] of edits) source = replace(source, reverse ? after : before, reverse ? before : after);
  return source;
}

export function patchOpenClawFilesystem(openclawDir) {
  const pkg = JSON.parse(fs.readFileSync(path.join(openclawDir, 'package.json'), 'utf8'));
  if (pkg.name !== 'openclaw' || pkg.version !== '2026.10.8') throw new Error(`${PATCH}: requires openclaw@2026.10.8`);
  const dist = path.join(openclawDir, 'dist');
  const helper = getOpenClawSafeDeleteSource();
  const helperFile = path.join(dist, HELPER);
  const helperExists = fs.existsSync(helperFile);
  if (helperExists && fs.readFileSync(helperFile, 'utf8') !== helper) throw new Error(`${PATCH}: emitted helper drift`);
  const changes = [];
  for (const [name, originalHash] of Object.entries(ORIGINAL)) {
    const file = path.join(dist, name);
    const source = fs.readFileSync(file, 'utf8');
    const stamp = source.match(new RegExp(`^// ${PATCH} sha256=([a-f0-9]{64})\\n`));
    if (stamp) {
      if (digest(source.slice(stamp[0].length)) !== stamp[1]) throw new Error(`${PATCH}: patched source drift: ${name}`);
      if (!helperExists) throw new Error(`${PATCH}: emitted helper missing`);
      continue;
    }
    if (digest(source) !== originalHash) throw new Error(`${PATCH}: upstream source changed: ${name}`);
    let next;
    if (name.startsWith('plugin-source-capture-directory-')) next = patchCaptureDirectory(source, 'fs', true);
    else if (name.startsWith('native-hook-relay/')) next = patchCaptureDirectory(source, 'fsSync', false);
    else next = patchSourceLookup(source);
    next = `import { safeRmSync as matchaSafeRmSync } from "${name.includes('/') ? '../' : './'}${HELPER}";\n` + next;
    changes.push([file, `// ${PATCH} sha256=${digest(next)}\n${next}`]);
  }
  if (!helperExists) fs.writeFileSync(helperFile, helper);
  for (const [file, source] of changes) fs.writeFileSync(file, source);
  return { status: changes.length || !helperExists ? 'applied' : 'clean', detail: 'plugin capture synchronous cleanup without following junctions' };
}
