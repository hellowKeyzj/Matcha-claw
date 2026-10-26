export function parsePolicyList(text: string): string[] {
  return [...new Set(text.split(/[\n,]/g).map((value) => value.trim()).filter(Boolean))];
}
