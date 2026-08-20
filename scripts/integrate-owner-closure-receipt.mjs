import { access, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  parseLedgerRecords,
  validateOwnerClosureLedger,
} from './validate-owner-closure-ledger.mjs';

const terminalStatuses = new Set(['passed', 'deleted-no-go', 'deferred-windows-receipt']);
const ownerReceiptName = /^O-(\d{3})\.json$/;

const replaceLedgerRecord = (ledgerContent, receipt) => {
  const { records, issues } = parseLedgerRecords(ledgerContent);
  if (issues.length > 0) {
    throw new Error(issues.join('\n'));
  }

  const index = records.findIndex((record) => record.owner_id === receipt.owner_id);
  if (index === -1) {
    throw new Error(`owner ${receipt.owner_id} is not present in the ledger`);
  }
  if (terminalStatuses.has(records[index].status)) {
    throw new Error(`owner ${receipt.owner_id} already has a terminal ledger record`);
  }

  const lines = ledgerContent.split(/\r?\n/);
  const fenceStart = lines.findIndex((line) => line === '```jsonl');
  if (fenceStart === -1) {
    throw new Error('ledger must contain one jsonl fenced block');
  }
  const recordLine = fenceStart + 1 + index;
  if (lines[recordLine] === '```') {
    throw new Error(`owner ${receipt.owner_id} ledger record is missing`);
  }
  lines[recordLine] = JSON.stringify(receipt);
  return lines.join('\n');
};

export const integrateOwnerClosureReceipt = async ({
  ledgerContent,
  allocationContent,
  receiptPath,
}) => {
  const receiptName = path.basename(receiptPath).match(ownerReceiptName);
  if (!receiptName) {
    throw new Error(`receipt filename must be O-xxx.json: ${receiptPath}`);
  }

  let receipt;
  try {
    receipt = JSON.parse(await readFile(receiptPath, 'utf8'));
  } catch (error) {
    throw new Error(`receipt must be valid JSON: ${error.message}`);
  }
  if (receipt.owner_id !== receiptName[1]) {
    throw new Error(`receipt owner_id must match filename O-${receiptName[1]}.json`);
  }
  if (!terminalStatuses.has(receipt.status)) {
    throw new Error(`receipt owner ${receipt.owner_id} must have a terminal status`);
  }
  if (path.basename(receipt.evidence_file ?? '') !== `O-${receipt.owner_id}.md`) {
    throw new Error(`owner ${receipt.owner_id} evidence_file must name O-${receipt.owner_id}.md`);
  }

  const { records, issues: ledgerIssues } = parseLedgerRecords(ledgerContent);
  if (ledgerIssues.length > 0) {
    throw new Error(ledgerIssues.join('\n'));
  }
  const current = records.find((record) => record.owner_id === receipt.owner_id);
  if (!current) {
    throw new Error(`owner ${receipt.owner_id} is not present in the ledger`);
  }
  if (terminalStatuses.has(current.status)) {
    throw new Error(`owner ${receipt.owner_id} already has a terminal ledger record`);
  }

  const issues = validateOwnerClosureLedger({
    ledgerContent: ['```jsonl', JSON.stringify(receipt), '```'].join('\n'),
    allocationContent,
    existingEvidenceFiles: new Set([receipt.evidence_file]),
  }).filter((issue) => !issue.startsWith('coverage allocation must contain exactly'))
    .filter((issue) => !issue.startsWith('missing owner_id '))
    .filter((issue) => !issue.startsWith('missing legacy_path '))
    .filter((issue) => !issue.startsWith('ledger must contain exactly'));
  if (issues.length > 0) {
    throw new Error(issues.join('\n'));
  }

  try {
    await access(receipt.evidence_file);
  } catch {
    throw new Error(`owner ${receipt.owner_id} evidence_file does not exist: ${receipt.evidence_file}`);
  }

  return replaceLedgerRecord(ledgerContent, receipt);
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
  const allocationPath = option('--allocation', path.join(root, 'docs/architecture/runtime-host-e2e/coverage-plan.md'));
  const receiptPath = option('--receipt');
  if (!receiptPath) {
    throw new Error('missing required --receipt <path>');
  }

  const [ledgerContent, allocationContent] = await Promise.all([
    readFile(ledgerPath, 'utf8'),
    readFile(allocationPath, 'utf8'),
  ]);
  const nextLedger = await integrateOwnerClosureReceipt({ ledgerContent, allocationContent, receiptPath });
  await writeFile(ledgerPath, nextLedger);
  console.log(`owner closure ledger: integrated ${path.basename(receiptPath)}`);
}
