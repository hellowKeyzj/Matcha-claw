interface ParsedVersion {
  major: number;
  minor: number;
  patch: number;
  prerelease: string[];
}

const VERSION_PATTERN = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/;
const NUMERIC_IDENTIFIER_PATTERN = /^\d+$/;

function parseVersion(version: string): ParsedVersion | null {
  const match = version.trim().match(VERSION_PATTERN);
  if (!match) {
    return null;
  }

  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
    prerelease: match[4] ? match[4].split('.') : [],
  };
}

function comparePrerelease(left: string[], right: string[]): number {
  if (left.length === 0 && right.length === 0) return 0;
  if (left.length === 0) return 1;
  if (right.length === 0) return -1;

  const count = Math.max(left.length, right.length);
  for (let index = 0; index < count; index += 1) {
    const leftPart = left[index];
    const rightPart = right[index];

    if (leftPart == null) return -1;
    if (rightPart == null) return 1;

    const leftIsNumeric = NUMERIC_IDENTIFIER_PATTERN.test(leftPart);
    const rightIsNumeric = NUMERIC_IDENTIFIER_PATTERN.test(rightPart);

    if (leftIsNumeric && rightIsNumeric) {
      const diff = Number(leftPart) - Number(rightPart);
      if (diff !== 0) return diff > 0 ? 1 : -1;
      continue;
    }

    if (leftIsNumeric) return -1;
    if (rightIsNumeric) return 1;

    const diff = leftPart.localeCompare(rightPart);
    if (diff !== 0) return diff > 0 ? 1 : -1;
  }

  return 0;
}

export function compareAppVersions(leftVersion: string, rightVersion: string): number | null {
  const left = parseVersion(leftVersion);
  const right = parseVersion(rightVersion);

  if (!left || !right) {
    return null;
  }

  for (const key of ['major', 'minor', 'patch'] as const) {
    const diff = left[key] - right[key];
    if (diff !== 0) return diff > 0 ? 1 : -1;
  }

  return comparePrerelease(left.prerelease, right.prerelease);
}

export function isUpdateVersionNewer(updateVersion: string, currentVersion: string): boolean {
  return compareAppVersions(updateVersion, currentVersion) === 1;
}
