#!/usr/bin/env zx

import 'zx/globals';
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptPath = fileURLToPath(import.meta.url);
const ROOT_DIR = path.resolve(dirname(scriptPath), '..');
export const UV_VERSION = '0.10.0';
const BASE_URL = `https://github.com/astral-sh/uv/releases/download/${UV_VERSION}`;
const OUTPUT_BASE = path.join(ROOT_DIR, 'resources', 'bin');

// Mapping Node platforms/archs to uv release naming
const TARGETS = {
  'darwin-arm64': {
    filename: 'uv-aarch64-apple-darwin.tar.gz',
    binName: 'uv',
  },
  'darwin-x64': {
    filename: 'uv-x86_64-apple-darwin.tar.gz',
    binName: 'uv',
  },
  'win32-arm64': {
    filename: 'uv-aarch64-pc-windows-msvc.zip',
    binName: 'uv.exe',
  },
  'win32-x64': {
    filename: 'uv-x86_64-pc-windows-msvc.zip',
    binName: 'uv.exe',
  },
  'linux-arm64': {
    filename: 'uv-aarch64-unknown-linux-gnu.tar.gz',
    binName: 'uv',
  },
  'linux-x64': {
    filename: 'uv-x86_64-unknown-linux-gnu.tar.gz',
    binName: 'uv',
  }
};

// Platform groups for building multi-arch packages
const PLATFORM_GROUPS = {
  'mac': ['darwin-x64', 'darwin-arm64'],
  'win': ['win32-x64', 'win32-arm64'],
  'linux': ['linux-x64', 'linux-arm64']
};

function cachedUvMatchesTarget({ executablePath, targetId }, dependencies = {}) {
  const pathExists = dependencies.existsSync ?? existsSync;
  const execute = dependencies.spawnSync ?? spawnSync;
  const readFile = dependencies.readFileSync ?? readFileSync;
  if (!pathExists(executablePath)) return false;
  try {
    const version = execute(executablePath, ['--version'], {
      encoding: 'utf8',
      timeout: 5_000,
      windowsHide: true,
    });
    if (version.error || version.status !== 0 || !new RegExp(`^uv ${UV_VERSION}(?: \\(.+\\))?$`).test(String(version.stdout ?? '').trim())) {
      return false;
    }
    if (targetId !== 'win32-x64' && targetId !== 'win32-arm64') return true;
    const binary = readFile(executablePath);
    const peOffset = binary.readUInt32LE(0x3c);
    const machine = binary.readUInt16LE(peOffset + 4);
    return machine === (targetId === 'win32-x64' ? 0x8664 : 0xaa64);
  } catch {
    return false;
  }
}

export function canReuseCachedUv({ executablePath, targetId }, dependencies) {
  return cachedUvMatchesTarget({ executablePath, targetId }, dependencies);
}

export function localFunctionalUvCacheEvidence({ executablePath, targetId }, dependencies) {
  if (targetId !== 'win32-x64' || !cachedUvMatchesTarget({ executablePath, targetId }, dependencies)) {
    return undefined;
  }
  return {
    source: 'local-cache',
    target: 'win32-x64',
    functionalMatch: 'exact-uv-0.10.0-win32-x64-pe',
    independentProvenance: 'unverified',
    supplyChainAttestation: 'not-present',
  };
}

async function setupTarget(id, { reuseFunctionalLocalCache = false } = {}) {
  const target = TARGETS[id];
  if (!target) {
    echo(chalk.yellow`⚠️ Target ${id} is not supported by this script.`);
    return;
  }

  const targetDir = path.join(OUTPUT_BASE, id);
  const tempDir = path.join(ROOT_DIR, 'temp_uv_extract');
  const archivePath = path.join(ROOT_DIR, target.filename);
  const downloadUrl = `${BASE_URL}/${target.filename}`;

  echo(chalk.blue`\n📦 Setting up uv for ${id}...`);

  // Do not wipe the whole target folder, otherwise other bundled tools may be deleted.
  // Also keep the old uv binary until the new one is ready, so interrupted downloads are harmless.
  const destBin = path.join(targetDir, target.binName);
  if (reuseFunctionalLocalCache && cachedUvMatchesTarget({ executablePath: destBin, targetId: id })) {
    echo(chalk.yellow`Using locally cached uv with functional target match and independently unverified provenance: ${destBin}`);
    return;
  }
  await fs.remove(tempDir);
  await fs.ensureDir(targetDir);
  await fs.ensureDir(tempDir);

  try {
    // Download
    echo`⬇️ Downloading: ${downloadUrl}`;
    const response = await fetch(downloadUrl);
    if (!response.ok) throw new Error(`Failed to download: ${response.statusText}`);
    const buffer = await response.arrayBuffer();
    await fs.writeFile(archivePath, Buffer.from(buffer));

    // Extract
    echo`📂 Extracting...`;
    if (target.filename.endsWith('.zip')) {
      if (os.platform() === 'win32') {
        const { execFileSync } = await import('child_process');
        const psCommand = `Add-Type -AssemblyName System.IO.Compression.FileSystem; [System.IO.Compression.ZipFile]::ExtractToDirectory('${archivePath.replace(/'/g, "''")}', '${tempDir.replace(/'/g, "''")}')`;
        execFileSync('powershell.exe', ['-NoProfile', '-Command', psCommand], { stdio: 'inherit' });
      } else {
        await $`unzip -q -o ${archivePath} -d ${tempDir}`;
      }
    } else {
      await $`tar -xzf ${archivePath} -C ${tempDir}`;
    }

    // Move binary
    // uv archives usually contain a folder named after the target
    const folderName = target.filename.replace('.tar.gz', '').replace('.zip', '');
    const sourceBin = path.join(tempDir, folderName, target.binName);

    if (await fs.pathExists(sourceBin)) {
      await fs.move(sourceBin, destBin, { overwrite: true });
    } else {
      echo(chalk.yellow`🔍 Binary not found in expected subfolder, searching...`);
      const files = await glob(`**/${target.binName}`, { cwd: tempDir, absolute: true });
      if (files.length > 0) {
        await fs.move(files[0], destBin, { overwrite: true });
      } else {
        throw new Error(`Could not find ${target.binName} in extracted files.`);
      }
    }

    // Permission fix
    if (os.platform() !== 'win32') {
      await fs.chmod(destBin, 0o755);
    }

    echo(chalk.green`✅ Success: ${destBin}`);
  } finally {
    // Cleanup
    await fs.remove(archivePath);
    await fs.remove(tempDir);
  }
}

// Main logic
if (process.argv.includes(scriptPath)) {
const downloadAll = argv.all;
const platform = argv.platform;
const target = argv.target;
const reuseFunctionalLocalCache = argv['reuse-functional-local-cache'] === true;
if (reuseFunctionalLocalCache && target !== 'win32-x64') {
  echo(chalk.red`❌ --reuse-functional-local-cache is restricted to --target=win32-x64.`);
  process.exit(1);
}

if (downloadAll) {
  // Download for all platforms
  echo(chalk.cyan`🌐 Downloading uv binaries for ALL supported platforms...`);
  for (const id of Object.keys(TARGETS)) {
    await setupTarget(id);
  }
} else if (target) {
  if (!TARGETS[target]) {
    echo(chalk.red`❌ Unknown target: ${target}`);
    echo(`Available targets: ${Object.keys(TARGETS).join(', ')}`);
    process.exit(1);
  }
  await setupTarget(target, { reuseFunctionalLocalCache });
} else if (platform) {
  // Download for a specific platform (e.g., --platform=mac)
  const targets = PLATFORM_GROUPS[platform];
  if (!targets) {
    echo(chalk.red`❌ Unknown platform: ${platform}`);
    echo(`Available platforms: ${Object.keys(PLATFORM_GROUPS).join(', ')}`);
    process.exit(1);
  }
  
  echo(chalk.cyan`🎯 Downloading uv binaries for platform: ${platform}`);
  echo(`   Architectures: ${targets.join(', ')}`);
  for (const id of targets) {
    await setupTarget(id);
  }
} else {
  // Download for current system only (default for local dev)
  const currentId = `${os.platform()}-${os.arch()}`;
  echo(chalk.cyan`💻 Detected system: ${currentId}`);
  
  if (TARGETS[currentId]) {
    await setupTarget(currentId);
  } else {
    echo(chalk.red`❌ Current system ${currentId} is not in the supported download list.`);
    echo(`Supported targets: ${Object.keys(TARGETS).join(', ')}`);
    echo(`\nTip: Use --platform=<platform> to download for a specific platform`);
    echo(`     Use --all to download for all platforms`);
    process.exit(1);
  }
}

echo(chalk.green`\n🎉 Done!`);
}
