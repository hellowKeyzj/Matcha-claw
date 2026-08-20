import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseLedgerRecords } from './validate-owner-closure-ledger.mjs';

const terminalStatuses = new Set(['passed', 'deleted-no-go', 'deferred-windows-receipt']);

export const seedOwnerClosureReceipts = async ({ ledgerContent, receiptDirectory }) => {
  const { records, issues } = parseLedgerRecords(ledgerContent);
  if (issues.length > 0) {
    throw new Error(issues.join('\n'));
  }

  await mkdir(receiptDirectory, { recursive: true });
  const seeded = [];
  for (const record of records) {
    if (!terminalStatuses.has(record.status)) {
      continue;
    }
    await writeFile(
      path.join(receiptDirectory, `O-${record.owner_id}.json`),
      `${JSON.stringify(record)}\n`,
      { flag: 'wx' },
    );
    seeded.push(record.owner_id);
  }
  return seeded;
};

const scriptPath = fileURLToPath(import.meta.url);
if (process.argv[1] && path.resolve(process.argv[1]) === scriptPath) {
  const root = path.resolve(path.dirname(scriptPath), '..');
  const args = process.argv.slice(2);
  const option = (name, fallback) => {
    const index = args.indexOf(name);
    return index === -1 ? fallback : args[index + 1];
  };
  const ledgerPath = option('--ledger', path.join(root, 'docs/architecture/runtime-host-e2e/owner-closure-ledger.md'));
  const receiptDirectory = option('--receipt-directory', path.join(root, 'docs/architecture/runtime-host-e2e/receipts'));
  const seeded = await seedOwnerClosureReceipts({
    ledgerContent: await readFile(ledgerPath, 'utf8'),
    receiptDirectory,
  });
  console.log(`owner closure receipts: seeded ${seeded.join(', ')}`);
}
