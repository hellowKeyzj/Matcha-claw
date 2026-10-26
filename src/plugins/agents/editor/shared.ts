export function areStringSetsEqual(left: readonly string[], right: readonly string[]): boolean {
  const normalizedLeft = [...left].sort();
  const normalizedRight = [...right].sort();
  if (normalizedLeft.length !== normalizedRight.length) {
    return false;
  }
  return normalizedLeft.every((item, index) => item === normalizedRight[index]);
}

export function toggleStringKey(keys: readonly string[], key: string, checked: boolean): string[] {
  if (checked) {
    return keys.includes(key) ? [...keys] : [...keys, key];
  }
  return keys.filter((item) => item !== key);
}
