export function resolveDeletedPath(pathname: string): string {
  return pathname.endsWith('.jsonl')
    ? pathname.replace(/\.jsonl$/, '.deleted.jsonl')
    : `${pathname}.deleted`;
}
