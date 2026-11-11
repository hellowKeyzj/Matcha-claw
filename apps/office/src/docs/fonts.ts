import { closeSync, openSync } from 'node:fs';
import { getFontIndex, readFaceNames } from '../../genoffice/packages/font-metrics/src/sfnt';

/** Reuse the metrics index, but expose original family names, never file paths. */
export function docsSystemFontFamilies(): string[] {
  const families = new Set<string>();
  const seen = new Set<string>();
  for (const faces of getFontIndex().byFamily.values()) for (const face of faces) {
    const key = `${face.path}:${face.offset}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const file = openSync(face.path, 'r');
    try {
      for (const family of readFaceNames(file, face.offset)?.families ?? []) if (family) families.add(family);
    } finally { closeSync(file); }
  }
  return [...families].sort((a, b) => a.localeCompare(b));
}
