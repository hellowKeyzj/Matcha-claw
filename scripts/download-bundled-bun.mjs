#!/usr/bin/env zx

import 'zx/globals';
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptPath = fileURLToPath(import.meta.url);
const ROOT_DIR = path.resolve(dirname(scriptPath), '..');
export const BUN_VERSION = 'bun-v1.3.5';
const BUN_SEMVER = BUN_VERSION.slice('bun-v'.length);
const BASE_URL = `https://github.com/oven-sh/bun/releases/download/${BUN_VERSION}`;
const OUTPUT_BASE = path.join(ROOT_DIR, 'resources', 'bin');

const TARGETS = {
  'darwin-arm64': {
    filename: `bun-darwin-aarch64.zip`,
    sourceDir: 'bun-darwin-aarch64',
    binName: 'bun',
  },
  'darwin-x64': {
    filename: `bun-darwin-x64.zip`,
    sourceDir: 'bun-darwin-x64',
    binName: 'bun',
  },
  'win32-arm64': {
    filename: `bun-windows-aarch64.zip`,
    sourceDir: 'bun-windows-aarch64',
    binName: 'bun.exe',
  },
  'win32-x64': {
    filename: `bun-windows-x64.zip`,
    sourceDir: 'bun-windows-x64',
    binName: 'bun.exe',
  },
  'linux-arm64': {
    filename: `bun-linux-aarch64.zip`,
    sourceDir: 'bun-linux-aarch64',
    binName: 'bun',
  },
  'linux-x64': {
    filename: `bun-linux-x64.zip`,
    sourceDir: 'bun-linux-x64',
    binName: 'bun',
  },
};

const PLATFORM_GROUPS = {
  mac: ['darwin-x64', 'darwin-arm64'],
  win: ['win32-x64', 'win32-arm64'],
  linux: ['linux-x64', 'linux-arm64'],
};

async function extractZip(archivePath, tempDir) {
  if (os.platform() === 'win32') {
    const { execFileSync } = await import('child_process');
    const psCommand = `Add-Type -AssemblyName System.IO.Compression.FileSystem; [System.IO.Compression.ZipFile]::ExtractToDirectory('${archivePath.replace(/'/g, "''")}', '${tempDir.replace(/'/g, "''")}')`;
    execFileSync('powershell.exe', ['-NoProfile', '-Command', psCommand], { stdio: 'inherit' });
    return;
  }
  await $`unzip -q -o ${archivePath} -d ${tempDir}`;
}

function cachedBunMatchesTarget({ executablePath, targetId }, dependencies = {}) {
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
    if (version.error || version.status !== 0 || String(version.stdout ?? '').trim() !== BUN_SEMVER) {
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

export function canReuseCachedBun({ executablePath, targetId }, dependencies) {
  return cachedBunMatchesTarget({ executablePath, targetId }, dependencies);
}

export function localFunctionalBunCacheEvidence({ executablePath, targetId }, dependencies) {
  if (targetId !== 'win32-x64' || !cachedBunMatchesTarget({ executablePath, targetId }, dependencies)) {
    return undefined;
  }
  return {
    source: 'local-cache',
    target: 'win32-x64',
    functionalMatch: 'exact-bun-1.3.5-win32-x64-pe',
    independentProvenance: 'unverified',
    supplyChainAttestation: 'not-present',
  };
}

async function setupTarget(id, { reuseFunctionalLocalCache = false } = {}) {
  const target = TARGETS[id];
  if (!target) {
    echo(chalk.red`❌ Target ${id} is not supported by this script.`);
    process.exitCode = 1;
    return;
  }

  const targetDir = path.join(OUTPUT_BASE, id);
  const tempDir = path.join(ROOT_DIR, `temp_bun_extract_${id}`);
  const archivePath = path.join(ROOT_DIR, target.filename);
  const downloadUrl = `${BASE_URL}/${target.filename}`;
  const outputBin = path.join(targetDir, target.binName);

  echo(chalk.blue`\n📦 Setting up Bun for ${id}...`);

  if (reuseFunctionalLocalCache && cachedBunMatchesTarget({ executablePath: outputBin, targetId: id })) {
    echo(chalk.yellow`Using locally cached Bun with functional target match and independently unverified provenance: ${outputBin}`);
    return;
  }

  await fs.remove(tempDir);
  await fs.ensureDir(targetDir);
  await fs.ensureDir(tempDir);

  try {
    echo`⬇️ Downloading: ${downloadUrl}`;
    let response;
    try {
      response = await fetch(downloadUrl);
    } catch (error) {
      if (id === 'win32-x64' && cachedBunMatchesTarget({ executablePath: outputBin, targetId: id })) {
        echo(chalk.yellow`Network producer unavailable; using locally cached Bun with functional target match and independently unverified provenance: ${outputBin}`);
        return;
      }
      throw error;
    }
    if (!response.ok) throw new Error(`Failed to download ${downloadUrl}: ${response.status} ${response.statusText}`);
    const buffer = await response.arrayBuffer();
    await fs.writeFile(archivePath, Buffer.from(buffer));

    echo`📂 Extracting...`;
    await extractZip(archivePath, tempDir);

    const expectedBin = path.join(tempDir, target.sourceDir, target.binName);
    if (await fs.pathExists(expectedBin)) {
      await fs.move(expectedBin, outputBin, { overwrite: true });
    } else {
      echo(chalk.yellow`🔍 Bun binary not found in expected directory, searching...`);
      const files = await glob(`**/${target.binName}`, { cwd: tempDir, absolute: true });
      if (files.length > 0) {
        await fs.move(files[0], outputBin, { overwrite: true });
      } else {
        throw new Error(`Could not find ${target.binName} in extracted files.`);
      }
    }

    if (os.platform() !== 'win32') {
      await fs.chmod(outputBin, 0o755);
    }

    echo(chalk.green`✅ Success: ${outputBin}`);
  } finally {
    await fs.remove(archivePath);
    await fs.remove(tempDir);
  }
}

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
  echo(chalk.cyan`🌐 Downloading Bun binaries for ALL supported platforms...`);
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
  const targets = PLATFORM_GROUPS[platform];
  if (!targets) {
    echo(chalk.red`❌ Unknown platform: ${platform}`);
    echo(`Available platforms: ${Object.keys(PLATFORM_GROUPS).join(', ')}`);
    process.exit(1);
  }
  echo(chalk.cyan`🎯 Downloading Bun binaries for platform: ${platform}`);
  echo(`   Architectures: ${targets.join(', ')}`);
  for (const id of targets) {
    await setupTarget(id);
  }
} else {
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

  if (process.exitCode && process.exitCode !== 0) {
    process.exit(process.exitCode);
  }

  echo(chalk.green`\n🎉 Done!`);
}
