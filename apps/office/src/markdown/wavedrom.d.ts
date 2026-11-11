declare module 'wavedrom' {
  export type JsonML = [string, ...unknown[]];
  export const waveSkin: unknown;
  export function renderAny(index: number, source: Record<string, unknown>, skin: unknown): JsonML;
  export const onml: { stringify(tree: JsonML): string };
}
