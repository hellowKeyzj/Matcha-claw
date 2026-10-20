import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';

const VERSION = '15.1.0';
const TARGETS = {
  'darwin-x64': ['x86_64-apple-darwin', 'tar.gz', '64811cb24e77cac3057d6c40b63ac9becf9082eedd54ca411b475b755d334882'],
  'darwin-arm64': ['aarch64-apple-darwin', 'tar.gz', '378e973289176ca0c6054054ee7f631a065874a352bf43f0fa60ef079b6ba715'],
  'win32-x64': ['x86_64-pc-windows-msvc', 'zip', '124510b94b6baa3380d051fdf4650eaa80a302c876d611e9dba0b2e18d87493a'],
  'win32-arm64': ['aarch64-pc-windows-msvc', 'zip', '00d931fb5237c9696ca49308818edb76d8eb6fc132761cb2a1bd616b2df02f8e'],
  'linux-x64': ['x86_64-unknown-linux-musl', 'tar.gz', '1c9297be4a084eea7ecaedf93eb03d058d6faae29bbc57ecdaf5063921491599'],
  'linux-arm64-gnu': ['aarch64-unknown-linux-gnu', 'tar.gz', '301eaf7e580272acb9e370d7b9f4ed9ba0b0fa8c3479e7282a895bbfe0f1076c'],
  'linux-arm64-musl': ['aarch64-unknown-linux-musl', 'tar.gz', 'dd3738a4b6e8df0fb3bc3edc5af352c4c39e0d97ad118a23e5176bdc5d48ba08'],
};
const rootDir = resolve(dirname(fileURLToPath(import.meta.url)), '..');

export async function prepareMatchaRipgrep(platform, arch) {
  const linuxArm64 = platform === 'linux' && arch === 'arm64';
  let libc = 'gnu';
  if (linuxArm64) {
    // Detect the build environment using the same rule as MatchaAgent postinstall.
    const muslArch = process.arch === 'x64' ? 'x86_64' : 'aarch64';
    try {
      statSync(`/lib/libc.musl-${muslArch}.so.1`);
      libc = 'musl';
    } catch {}
  }
  const target = TARGETS[`${platform}-${arch}${linuxArm64 ? `-${libc}` : ''}`];
  if (!target) throw new Error(`Unsupported ripgrep target: ${platform}-${arch}`);
  const [triple, extension, checksum] = target;
  // Upstream 15.1.0 has no ARM64 musl asset; retain the original official release.
  const version = linuxArm64 ? '15.0.1' : VERSION;
  const releaseBase = linuxArm64
    ? `https://github.com/microsoft/ripgrep-prebuilt/releases/download/v${version}`
    : `https://github.com/BurntSushi/ripgrep/releases/download/${version}`;
  const directory = linuxArm64 ? '' : `ripgrep-${version}-${triple}`;
  const filename = linuxArm64 ? `ripgrep-v${version}-${triple}.${extension}` : `${directory}.${extension}`;
  const cacheDir = join(rootDir, 'build', 'ripgrep');
  const archive = join(cacheDir, filename);
  mkdirSync(cacheDir, { recursive: true });
  if (!existsSync(archive)) {
    const response = await fetch(`${releaseBase}/${filename}`);
    if (!response.ok) throw new Error(`Ripgrep download failed: ${response.status} ${filename}`);
    const bytes = Buffer.from(await response.arrayBuffer());
    if (createHash('sha256').update(bytes).digest('hex') !== checksum) {
      throw new Error(`Ripgrep checksum mismatch: ${filename}`);
    }
    writeFileSync(archive, bytes);
  }
  if (createHash('sha256').update(readFileSync(archive)).digest('hex') !== checksum) {
    throw new Error(`Ripgrep cache checksum mismatch: ${filename}`);
  }
  const extracted = mkdtempSync(join(tmpdir(), 'matcha-ripgrep-'));
  try {
    const result = extension === 'zip' && process.platform === 'win32'
      ? spawnSync('powershell.exe', ['-NoProfile', '-Command',
        `Expand-Archive -LiteralPath '${archive.replace(/'/g, "''")}' -DestinationPath '${extracted.replace(/'/g, "''")}'`], { stdio: 'inherit' })
      : spawnSync(process.platform === 'win32' ? join(process.env.SystemRoot, 'System32', 'tar.exe') : 'tar',
        ['-xf', archive, '-C', extracted], { stdio: 'inherit' });
    if (result.error) throw result.error;
    if (result.status !== 0) throw new Error(`Ripgrep extraction failed: ${filename}`);
    const binary = platform === 'win32' ? 'rg.exe' : 'rg';
    const destination = join(rootDir, 'matcha-agent', 'src', 'utils', 'vendor', 'ripgrep', `${arch}-${platform}`, binary);
    mkdirSync(dirname(destination), { recursive: true });
    const source = join(extracted, directory, binary);
    if (!existsSync(destination) || !readFileSync(source).equals(readFileSync(destination))) {
      copyFileSync(source, destination);
    }
    if (platform !== 'win32') chmodSync(destination, 0o755);
    console.log(`[build-matcha-agent] ripgrep ${version} (${triple}) prepared for ${platform}-${arch}`);
  } finally {
    rmSync(extracted, { recursive: true, force: true });
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  if (process.env.SKIP_MATCHA_AGENT_BUILD === '1') {
    console.log('[build-matcha-agent] SKIP_MATCHA_AGENT_BUILD=1 set; skipping ripgrep preparation.');
  } else {
    const { values } = parseArgs({ options: { arch: { type: 'string', multiple: true } } });
    const architectures = [...new Set(values.arch ?? [process.arch])].sort();
    for (const arch of architectures) {
      if (!['x64', 'arm64'].includes(arch)) {
        throw new Error(`[build-matcha-agent] unsupported architecture: ${arch}`);
      }
    }
    for (const arch of architectures) await prepareMatchaRipgrep(process.platform, arch);
  }
}
