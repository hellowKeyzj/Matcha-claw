const { execFileSync } = require('node:child_process');
const { createHash } = require('node:crypto');
const { readFile, readdir, writeFile } = require('node:fs/promises');
const { createRequire } = require('node:module');
const { join } = require('node:path');

module.exports = async function signSearxng(packager, resourcesDir) {
  const builderRequire = createRequire(require.resolve('electron-builder/package.json'));
  const { findIdentity, isSignAllowed } = builderRequire('app-builder-lib/out/codeSign/macCodeSign');
  const options = packager.platformSpecificBuildOptions;
  if (!isSignAllowed() || options.identity === null || options.identity === '-' || options.type === 'development') {
    if (packager.forceCodeSigning) throw new Error('SearXNG release wheels require Developer ID signing');
    console.log('[searxng-sign] Skipped for unsigned/development packaging.');
    return;
  }
  const { keychainFile } = await packager.codeSigningInfo.value;
  const identity = await findIdentity('Developer ID Application', options.identity, keychainFile);
  if (!identity?.name.startsWith('Developer ID Application:')) {
    if (packager.forceCodeSigning) throw new Error('No Developer ID Application identity for SearXNG wheels');
    console.log('[searxng-sign] No Developer ID Application identity; leaving development wheels unchanged.');
    return;
  }

  const root = join(__dirname, '..');
  const uv = join(root, 'resources', 'bin', `${process.platform}-${process.arch}`, 'uv');
  const env = { ...process.env, UV_PYTHON_DOWNLOADS: 'never', UV_NO_CONFIG: '1' };
  const python = execFileSync(uv, ['python', 'find', '3.12', '--no-python-downloads'], {
    cwd: root, env, encoding: 'utf8',
  }).trim();
  execFileSync(python, ['-I', '-B', join(__dirname, 'sign-searxng.py'), resourcesDir,
    identity.hash || identity.name, ...(keychainFile ? [keychainFile] : [])], {
    cwd: root, env, stdio: 'inherit',
  });

  const { treeDigest } = await import('./searxng-integrity.mjs');
  const manifestPath = join(resourcesDir, 'manifest.json');
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  const requirements = await readFile(join(resourcesDir, 'requirements.lock'));
  manifest.requirementsSha256 = createHash('sha256').update(requirements).digest('hex');
  for (const entry of await readdir(join(resourcesDir, 'wheels'), { withFileTypes: true })) {
    if (entry.isDirectory() && entry.name.startsWith('darwin-')) {
      manifest.targets[entry.name] = await treeDigest(join(resourcesDir, 'wheels', entry.name));
    }
  }
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
};
