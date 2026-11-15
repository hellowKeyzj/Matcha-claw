import { execFileSync } from 'node:child_process';
import { open, readdir } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { join } from 'node:path';

const require = createRequire(import.meta.url);
const machOMagic = new Set([0xfeedface, 0xfeedfacf, 0xcefaedfe, 0xcffaedfe,
  0xcafebabe, 0xcafebabf, 0xbebafeca, 0xbfbafeca]);

async function findMachOFiles(directory, prefix = '') {
  const binaries = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    const name = prefix + entry.name;
    if (entry.isDirectory()) {
      binaries.push(...await findMachOFiles(path, name + '/'));
    } else if (entry.isFile()) {
      const file = await open(path, 'r');
      try {
        const header = Buffer.alloc(8);
        const { bytesRead } = await file.read(header, 0, header.length, 0);
        if (bytesRead === header.length && machOMagic.has(header.readUInt32BE(0))) binaries.push(name);
      } finally {
        await file.close();
      }
    }
  }
  return binaries;
}

export async function signAppPluginNative(directory, packager, name, binaries) {
  if (!packager) {
    console.log(`[app-plugin-sign] ${name}: no packager; leaving development binaries unsigned.`);
    return;
  }
  const builderRequire = createRequire(require.resolve('electron-builder/package.json'));
  const { findIdentity, isSignAllowed } = builderRequire('app-builder-lib/out/codeSign/macCodeSign');
  const options = packager.platformSpecificBuildOptions;
  if (!isSignAllowed() || options.identity === null || options.identity === '-' || options.type === 'development') {
    if (packager.forceCodeSigning) throw new Error(`Bundled ${name} release binaries require Developer ID signing.`);
    console.log(`[app-plugin-sign] ${name}: skipped for unsigned/development packaging.`);
    return;
  }
  const { keychainFile } = await packager.codeSigningInfo.value;
  const identity = await findIdentity('Developer ID Application', options.identity, keychainFile);
  if (!identity?.name.startsWith('Developer ID Application:')) {
    if (packager.forceCodeSigning) throw new Error(`No Developer ID Application identity for bundled ${name} binaries.`);
    console.log(`[app-plugin-sign] ${name}: no Developer ID Application identity; leaving development binaries unchanged.`);
    return;
  }
  // App signing cannot reach Mach-O members inside the plugin ZIP.
  const files = binaries ?? await findMachOFiles(directory);
  for (const binary of files) {
    const file = join(directory, binary);
    execFileSync('/usr/bin/codesign', ['--force', '--sign', identity.hash || identity.name,
      '--timestamp', '--options', 'runtime', ...(keychainFile ? ['--keychain', keychainFile] : []), file],
    { stdio: 'inherit', timeout: 120_000 });
    execFileSync('/usr/bin/codesign', ['--verify', '--strict', '--all-architectures', '--test-requirement',
      '=anchor apple generic and certificate leaf[field.1.2.840.113635.100.6.1.13] exists', file],
    { stdio: 'inherit', timeout: 120_000 });
  }
  console.log(`[app-plugin-sign] ${name}: signed and verified ${files.length} Mach-O files with ${identity.name}.`);
}
