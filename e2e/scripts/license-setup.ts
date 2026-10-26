import { stdin } from 'node:process';
import { createInterface } from 'node:readline/promises';
import { Writable } from 'node:stream';
import { resolve } from 'node:path';
import { UseElectron } from '../src/abilities/use-electron.ability.js';
import { repositoryRoot } from '../src/config/electron.js';

async function readSecret(): Promise<string> {
  if (!stdin.isTTY) {
    const chunks: Buffer[] = [];
    for await (const chunk of stdin) chunks.push(Buffer.from(chunk));
    const key = Buffer.concat(chunks).toString('utf8').trim();
    for (const chunk of chunks) chunk.fill(0);
    return key;
  }
  process.stdout.write('License key (hidden): ');
  const mutedOutput = new Writable({ write(_chunk, _encoding, done) { done(); } });
  const lines = createInterface({ input: stdin, output: mutedOutput, terminal: true });
  try {
    return (await lines.question('')).trim();
  } finally {
    lines.close();
    mutedOutput.end();
    process.stdout.write('\n');
  }
}

let key = await readSecret();
if (!key || key.includes('\n') || key.includes('\r')) throw new Error('Supply one license key through stdin');
const evidence = resolve(repositoryRoot, 'e2e/.cache/license-activation');
const owner = await UseElectron.start(evidence, true);
try {
  await owner.activateLicense(key);
  key = '';
  console.log('Dedicated E2E profile license verified. Activation trace and screenshots are disabled.');
} finally {
  key = '';
  await owner.close();
}
