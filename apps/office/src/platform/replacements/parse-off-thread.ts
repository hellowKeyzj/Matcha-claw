import { parseDocx } from '@genoffice/docx-engine';

export const parseStats = { worker: 0, inline: 0 };

export async function parseDocxOffThread(bytes: Uint8Array) {
  parseStats.inline++;
  return parseDocx(bytes);
}
