export const EXTRA_OPENCLAW_RUNTIME_PACKAGES = [
  'acpx',
  'playwright-core',
];

export function mergeOpenClawRuntimePackages(...groups) {
  const merged = [];
  const seen = new Set();
  for (const group of groups) {
    for (const value of group ?? []) {
      if (typeof value !== 'string') {
        continue;
      }
      const packageName = value.trim();
      if (!packageName || seen.has(packageName)) {
        continue;
      }
      seen.add(packageName);
      merged.push(packageName);
    }
  }
  return merged;
}
