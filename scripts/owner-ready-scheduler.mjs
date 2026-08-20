import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const terminalStatuses = new Set(['passed', 'deleted-no-go', 'deferred-windows-receipt']);
const activeStatuses = new Set(['semantic-frozen', 'implementing', 'e2e-running', 'e2e-failed', 'rerunning']);
const exclusiveSeamKind = 'exclusive';

export const parseJsonlRecords = (content) => (content
  .match(/```jsonl\r?\n([\s\S]*?)\r?\n```/)?.[1] ?? content)
  .split(/\r?\n/)
  .filter(Boolean)
  .map((line) => JSON.parse(line));

const hasOwn = (value, key) => Object.prototype.hasOwnProperty.call(value, key);
const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);

export const validateOwnerSchedulerBoundaries = ({ records, boundaries }) => {
  const diagnostics = [];
  if (!isObject(boundaries) || boundaries.version !== 2) {
    diagnostics.push('manifest version must be 2');
    return diagnostics;
  }
  if (!isObject(boundaries.owners)) {
    diagnostics.push('manifest owners must be an object');
    return diagnostics;
  }
  if (!isObject(boundaries.write_seams)) {
    diagnostics.push('manifest write_seams must be an object');
    return diagnostics;
  }

  const ledgerOwnerIds = new Set();
  for (const record of records) {
    if (typeof record.owner_id !== 'string' || record.owner_id === '') {
      diagnostics.push('ledger record has no owner_id');
      continue;
    }
    if (ledgerOwnerIds.has(record.owner_id)) {
      diagnostics.push(`ledger has duplicate owner_id ${record.owner_id}`);
    }
    ledgerOwnerIds.add(record.owner_id);
  }

  const manifestOwnerIds = Object.keys(boundaries.owners);
  for (const ownerId of ledgerOwnerIds) {
    if (!hasOwn(boundaries.owners, ownerId)) {
      diagnostics.push(`manifest is missing owner ${ownerId}`);
    }
  }
  for (const ownerId of manifestOwnerIds) {
    if (!ledgerOwnerIds.has(ownerId)) {
      diagnostics.push(`manifest has unknown owner ${ownerId}`);
    }
  }

  const protectedPaths = new Map();
  for (const [seamId, seam] of Object.entries(boundaries.write_seams)) {
    if (!isObject(seam)) {
      diagnostics.push(`write seam ${seamId} must be an object`);
      continue;
    }
    if (seam.kind !== exclusiveSeamKind) {
      diagnostics.push(`write seam ${seamId} kind must be ${exclusiveSeamKind}`);
    }
    if (!Array.isArray(seam.protected_paths) || seam.protected_paths.length === 0 || seam.protected_paths.some((entry) => typeof entry !== 'string' || entry === '')) {
      diagnostics.push(`write seam ${seamId} must declare nonempty protected_paths`);
    } else if (seam.kind === exclusiveSeamKind) {
      for (const protectedPath of seam.protected_paths) {
        const existingSeamId = protectedPaths.get(protectedPath);
        if (existingSeamId) {
          diagnostics.push(`exclusive write seams ${existingSeamId} and ${seamId} duplicate protected path ${protectedPath}`);
        } else {
          protectedPaths.set(protectedPath, seamId);
        }
      }
    }
    if (typeof seam.description !== 'string' || seam.description.trim() === '') {
      diagnostics.push(`write seam ${seamId} must declare a description`);
    }
  }

  for (const [ownerId, assignment] of Object.entries(boundaries.owners)) {
    if (!isObject(assignment) || !Array.isArray(assignment.writes) || assignment.writes.some((seamId) => typeof seamId !== 'string')) {
      diagnostics.push(`owner ${ownerId} assignment must be { writes: [] | [seam ids] }`);
      continue;
    }
    const assignedSeams = new Set();
    for (const seamId of assignment.writes) {
      if (assignedSeams.has(seamId)) {
        diagnostics.push(`owner ${ownerId} assigns write seam ${seamId} more than once`);
      }
      assignedSeams.add(seamId);
      if (!hasOwn(boundaries.write_seams, seamId)) {
        diagnostics.push(`owner ${ownerId} assigns unknown write seam ${seamId}`);
      }
    }
  }

  return diagnostics;
};

const assertOwnerSchedulerBoundaries = ({ records, boundaries }) => {
  const diagnostics = validateOwnerSchedulerBoundaries({ records, boundaries });
  if (diagnostics.length > 0) {
    throw new Error(`Invalid owner scheduler boundary manifest:\n${diagnostics.join('\n')}`);
  }
};

export const assertTerminalReceiptProjection = ({ ledgerContent, receipts }) => {
  for (const record of parseJsonlRecords(ledgerContent)) {
    if (!terminalStatuses.has(record.status)) {
      continue;
    }
    const receipt = receipts.get(record.owner_id);
    if (!receipt) {
      throw new Error(`owner ${record.owner_id} terminal ledger record has no immutable receipt`);
    }
    if (JSON.stringify(receipt) !== JSON.stringify(record)) {
      throw new Error(`owner ${record.owner_id} ledger record does not match immutable receipt`);
    }
  }
};

export const selectReadyOwners = ({ ledgerContent, boundaries }) => {
  const records = parseJsonlRecords(ledgerContent);
  assertOwnerSchedulerBoundaries({ records, boundaries });
  const byId = new Map(records.map((record) => [record.owner_id, record]));
  const activeSeams = new Set(records
    .filter((record) => activeStatuses.has(record.status))
    .flatMap((record) => boundaries.owners[record.owner_id].writes));

  const claimedSeams = new Set(activeSeams);
  const readyOwnerIds = [];
  for (const record of records
    .filter((record) => record.status === 'open')
    .filter((record) => record.dependency_ids.every((dependencyId) => terminalStatuses.has(byId.get(dependencyId)?.status)))
    .sort((left, right) => left.owner_id.localeCompare(right.owner_id))) {
    const writes = boundaries.owners[record.owner_id].writes;
    if (writes.some((seamId) => claimedSeams.has(seamId))) {
      continue;
    }
    readyOwnerIds.push(record.owner_id);
    writes.forEach((seamId) => claimedSeams.add(seamId));
  }

  return { ready_owner_ids: readyOwnerIds };
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
  const boundariesPath = option('--boundaries', path.join(root, 'docs/architecture/runtime-host-e2e/owner-shared-write-boundaries.json'));
  const receiptsDirectory = option('--receipts-directory', path.join(root, 'docs/architecture/runtime-host-e2e/receipts'));
  const [ledgerContent, boundariesContent, receiptNames] = await Promise.all([
    readFile(ledgerPath, 'utf8'),
    readFile(boundariesPath, 'utf8'),
    readdir(receiptsDirectory),
  ]);
  const receiptEntries = await Promise.all(receiptNames
    .filter((name) => /^O-\d{3}\.json$/.test(name))
    .sort()
    .map(async (name) => {
      const receipt = JSON.parse(await readFile(path.join(receiptsDirectory, name), 'utf8'));
      return [receipt.owner_id, receipt];
    }));
  assertTerminalReceiptProjection({ ledgerContent, receipts: new Map(receiptEntries) });

  console.log(JSON.stringify(selectReadyOwners({
    ledgerContent,
    boundaries: JSON.parse(boundariesContent),
  })));
}
