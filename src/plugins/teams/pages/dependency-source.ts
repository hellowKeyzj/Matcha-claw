export function normalizeDependencySource(source: string | undefined): string {
  return source?.trim() ?? '';
}

export function isOpenableDependencySource(source: string | undefined): boolean {
  return /^https?:\/\//i.test(normalizeDependencySource(source));
}

export function isLocalDependencySource(source: string | undefined): boolean {
  const value = normalizeDependencySource(source);
  if (!value || isOpenableDependencySource(value) || isClawHubDependencySource(value)) {
    return false;
  }
  return value.startsWith('.')
    || value.startsWith('/')
    || value.startsWith('~')
    || /^[a-z]:[\\/]/i.test(value)
    || value.includes('/')
    || value.includes('\\');
}

export function isClawHubDependencySource(source: string | undefined): boolean {
  const value = normalizeDependencySource(source);
  if (!value) {
    return false;
  }
  if (/^clawhub:(\/\/)?/i.test(value)) {
    return true;
  }
  if (!isOpenableDependencySource(value)) {
    return false;
  }
  try {
    return new URL(value).hostname.toLowerCase().includes('clawhub');
  } catch {
    return false;
  }
}

export function readClawHubSkillSlug(name: string, source: string | undefined): string {
  const value = normalizeDependencySource(source);
  if (/^clawhub:\/\//i.test(value)) {
    return value.replace(/^clawhub:\/\//i, '').split(/[/?#]/)[0]?.trim() || name;
  }
  if (/^clawhub:/i.test(value)) {
    return value.replace(/^clawhub:/i, '').split(/[/?#]/)[0]?.trim() || name;
  }
  if (isOpenableDependencySource(value)) {
    try {
      const url = new URL(value);
      const slug = url.pathname.split('/').filter(Boolean).at(-1)?.trim();
      return slug || name;
    } catch {
      return name;
    }
  }
  return name;
}
