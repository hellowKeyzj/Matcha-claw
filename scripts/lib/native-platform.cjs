const { existsSync, readdirSync } = require('fs');
const { join } = require('path');
const { safeRmSync } = require('./safe-delete.mjs');

const PLATFORM_ALIASES = {
  darwin: 'darwin', mac: 'darwin',
  linux: 'linux', linuxmusl: 'linux',
  win32: 'win32', win: 'win32', windows: 'win32',
};

// Capture platform and base architecture; libc/GPU suffixes remain valid variants.
const PLATFORM_NATIVE_SCOPES = {
  '@napi-rs': /^canvas-(darwin|linux|win32|android)-(x64|arm64|arm|riscv64)/,
  '@img': /^sharp(?:-libvips)?-(darwin|linux(?:musl)?|win32)-(x64|arm64|arm|ppc64|riscv64|s390x)/,
  '@mariozechner': /^clipboard-(darwin|linux|win32)-(x64|arm64|universal)/,
  '@snazzah': /^davey-(darwin|linux|android|freebsd|win32)-(x64|arm64|arm|ia32)/,
  '@lydell': /^node-pty-(darwin|linux|win32)-(x64|arm64|ia32|armv7l)(?:-.+)?$/,
  '@reflink': /^reflink-(darwin|linux|win32)-(x64|arm64)/,
  '@node-llama-cpp': /^(mac|linux|win)-(arm64|x64|armv7l)(-metal|-cuda|-cuda-ext|-vulkan)?$/,
  '@esbuild': /^(darwin|linux|win32|android|freebsd|netbsd|openbsd|sunos|aix|openharmony)-(x64|arm64|arm|ia32|loong64|mips64el|ppc64|riscv64|s390x)/,
  '@lancedb': /^lancedb-(darwin|linux|win32)-(x64|arm64)(?:-.+)?$/,
  '@trycua': /^cua-driver-(darwin|linux|win32)-(x64|arm64)(?:-.+)?$/,
  '@koromix': /^koffi-(darwin|linux|win32|freebsd|openbsd)-(x64|arm64|ia32|riscv64|loong64)$/,
  '@ubjs': /^node-(darwin|linux|win32)-(x64|arm64)(?:-.+)?$/,
  '@wecom': /^cli-(darwin|linux|win32)-(x64|arm64)$/,
  '@openclaw': /^fs-safe-(darwin|linux|win32)-(x64|arm64)(?:-.+)?$/,
};
const UNSCOPED_NATIVE_PACKAGES = [
  { pattern: /^sqlite-vec-(darwin|linux|windows)-(x64|arm64)$/ },
];

function baseArch(rawArch) {
  return rawArch.split('-')[0];
}

function targetArchitectures(arch) {
  return arch === 'universal' ? ['x64', 'arm64'] : [arch];
}

function matchesTargetArch(pkgArch, targetArch) {
  return pkgArch === 'universal' ||
    pkgArch.split('+').some(arch => targetArchitectures(targetArch).includes(arch));
}

function matchesTarget(platform, arch, pkgPlatform, pkgArch) {
  return (PLATFORM_ALIASES[pkgPlatform] || pkgPlatform) === platform &&
    matchesTargetArch(baseArch(pkgArch), arch);
}

function isNonTargetNativePackage(name, platform, arch) {
  if (name === 'fsevents') return !matchesTarget(platform, arch, 'darwin', 'universal');
  const [scope, entry] = name.split('/');
  const pattern = PLATFORM_NATIVE_SCOPES[scope];
  const match = entry ? pattern && entry.match(pattern) :
    UNSCOPED_NATIVE_PACKAGES.map(({ pattern }) => name.match(pattern)).find(Boolean);
  return Boolean(match && !matchesTarget(platform, arch, match[1], match[2]));
}

function cleanupNativePlatformPackages(nodeModulesDir, platform, arch) {
  let removed = 0;
  for (const scope of Object.keys(PLATFORM_NATIVE_SCOPES)) {
    const scopeDir = join(nodeModulesDir, scope);
    if (!existsSync(scopeDir)) continue;
    for (const entry of readdirSync(scopeDir)) {
      if (isNonTargetNativePackage(`${scope}/${entry}`, platform, arch)) {
        if (safeRmSync(join(scopeDir, entry), { root: scopeDir })) removed++;
      }
    }
  }
  if (!existsSync(nodeModulesDir)) return removed;
  for (const entry of readdirSync(nodeModulesDir)) {
    if (isNonTargetNativePackage(entry, platform, arch)) {
      if (safeRmSync(join(nodeModulesDir, entry), { root: nodeModulesDir })) removed++;
    }
  }
  return removed;
}

function cleanupPlatformDirectories(dir, platform, arch, separator = '-') {
  if (!existsSync(dir)) return 0;
  let removed = 0;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const [pkgPlatform, pkgArch] = entry.name.split(separator);
    if (!/^(darwin|linux|linuxmusl|win32|android|ios|freebsd|openbsd|netbsd)$/.test(pkgPlatform) || !pkgArch) continue;
    if (!matchesTarget(platform, arch, pkgPlatform, pkgArch)) {
      if (safeRmSync(join(dir, entry.name), { root: dir })) removed++;
    }
  }
  return removed;
}

function cleanupKoffi(nodeModulesDir, platform, arch) {
  return cleanupPlatformDirectories(join(nodeModulesDir, 'koffi', 'build', 'koffi'), platform, arch, '_');
}

function cleanupOnnxRuntimeBinaries(napiDir, platform, arch) {
  if (!existsSync(napiDir)) return 0;
  let removed = 0;
  for (const entry of readdirSync(napiDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const dir = join(napiDir, entry.name);
    if (entry.name !== platform) {
      if (safeRmSync(dir, { root: napiDir })) removed++;
      continue;
    }
    for (const variant of readdirSync(dir, { withFileTypes: true })) {
      if (variant.isDirectory() && !matchesTargetArch(baseArch(variant.name), arch)) {
        if (safeRmSync(join(dir, variant.name), { root: dir })) removed++;
      }
    }
  }
  return removed;
}

function cleanupOnnxRuntimeNodeBinaries(nodeModulesDir, platform, arch) {
  return cleanupOnnxRuntimeBinaries(join(nodeModulesDir, 'onnxruntime-node', 'bin', 'napi-v6'), platform, arch);
}

// Only package-owned native layouts and nested dependency roots, never arbitrary binaries.
function cleanupNativeDependencyTree(nodeModulesDir, platform, arch) {
  if (!existsSync(nodeModulesDir)) return 0;
  let removed = cleanupNativePlatformPackages(nodeModulesDir, platform, arch) +
    cleanupKoffi(nodeModulesDir, platform, arch) + cleanupOnnxRuntimeNodeBinaries(nodeModulesDir, platform, arch);
  const packages = [];
  for (const entry of readdirSync(nodeModulesDir, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.name.startsWith('.')) continue;
    const dir = join(nodeModulesDir, entry.name);
    if (entry.name.startsWith('@')) {
      for (const pkg of readdirSync(dir, { withFileTypes: true })) {
        if (pkg.isDirectory()) packages.push([`${entry.name}/${pkg.name}`, join(dir, pkg.name)]);
      }
    } else {
      packages.push([entry.name, dir]);
    }
  }
  for (const [name, dir] of packages) {
    if (['tree-sitter-bash', 'bare-fs', 'bare-os', 'bare-url'].includes(name)) {
      removed += cleanupPlatformDirectories(join(dir, 'prebuilds'), platform, arch);
    }
    if (name === '@mariozechner/pi-tui' || name === '@earendil-works/pi-tui') {
      const native = join(dir, 'native');
      if (existsSync(native)) {
        for (const entry of readdirSync(native, { withFileTypes: true })) {
          if (!entry.isDirectory() || !['darwin', 'win32'].includes(entry.name)) continue;
          if (entry.name !== platform) {
            if (safeRmSync(join(native, entry.name), { root: native })) removed++;
          } else {
            removed += cleanupPlatformDirectories(join(native, entry.name, 'prebuilds'), platform, arch);
          }
        }
      }
    }
    removed += cleanupNativeDependencyTree(join(dir, 'node_modules'), platform, arch);
  }
  return removed;
}

module.exports = {
  PLATFORM_NATIVE_SCOPES, targetArchitectures, matchesTarget, isNonTargetNativePackage, cleanupNativePlatformPackages,
  cleanupOnnxRuntimeBinaries, cleanupNativeDependencyTree,
};
