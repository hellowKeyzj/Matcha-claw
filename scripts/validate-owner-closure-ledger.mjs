import { access, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ownerIdPattern = /^\d{3}$/;
const requiredFields = [
  'owner_id',
  'legacy_path',
  'status',
  'dependency_ids',
  'historical_revision_path_line',
  'full_caller_route_registry_chain',
  'semantic_classification',
  'final_owner',
  'active_consumer',
  'active_path',
  'sealed_public_dto',
  'implementation_files',
  'e2e_command',
  'selected_test_count',
  'e2e_result',
  'rejection_unknown_recovery',
  'authorization',
  'secret_redaction',
  'recovery_idempotency',
  'legacy_residual',
  'technical_gate_attestation',
  'windows_x64_evidence',
  'evidence_file',
  'timestamp',
];
const statuses = new Set([
  'open',
  'semantic-frozen',
  'implementing',
  'e2e-running',
  'e2e-failed',
  'rerunning',
  'passed',
  'deleted-no-go',
  'deferred-windows-receipt',
]);
const terminalStatuses = new Set(['passed', 'deleted-no-go', 'deferred-windows-receipt']);
const semanticClassifications = new Set(['preserve', 'improve', 'defect', 'unproven']);

export const parseCoverageAllocation = (content) => [...content.matchAll(/^\|\s*(\d{3})\s*\|\s*`([^`]+)`\s*\|/gm)]
  .map(([, owner_id, legacy_path]) => ({ owner_id, legacy_path }));

export const parseLedgerRecords = (content) => {
  const match = content.match(/```jsonl\r?\n([\s\S]*?)\r?\n```/);
  if (!match) {
    return { records: [], issues: ['ledger must contain one jsonl fenced block'] };
  }

  const issues = [];
  const records = match[1].split(/\r?\n/).filter(Boolean).map((line, index) => {
    try {
      return JSON.parse(line);
    } catch {
      issues.push(`ledger record ${index + 1} is not valid JSON`);
      return null;
    }
  }).filter(Boolean);
  return { records, issues };
};

const isBlank = (value) => typeof value !== 'string' || value.trim() === '';

export const validateOwnerClosureLedger = ({ ledgerContent, allocationContent, existingEvidenceFiles }) => {
  const { records, issues } = parseLedgerRecords(ledgerContent);
  const allocation = parseCoverageAllocation(allocationContent);
  const expectedById = new Map(allocation.map((entry) => [entry.owner_id, entry.legacy_path]));
  const expectedPaths = new Set(allocation.map((entry) => entry.legacy_path));
  const seenIds = new Set();
  const seenPaths = new Set();

  if (allocation.length !== 589) {
    issues.push(`coverage allocation must contain exactly 589 rows, found ${allocation.length}`);
  }
  if (new Set(allocation.map((entry) => entry.owner_id)).size !== allocation.length) {
    issues.push('coverage allocation contains duplicate owner IDs');
  }
  if (expectedPaths.size !== allocation.length) {
    issues.push('coverage allocation contains duplicate legacy paths');
  }

  for (const [index, record] of records.entries()) {
    const prefix = `ledger record ${index + 1}`;
    for (const field of requiredFields) {
      if (!(field in record)) {
        issues.push(`${prefix} is missing ${field}`);
      }
    }
    for (const field of Object.keys(record)) {
      if (!requiredFields.includes(field)) {
        issues.push(`${prefix} has unexpected ${field}`);
      }
    }
    if (!ownerIdPattern.test(record.owner_id ?? '')) {
      issues.push(`${prefix} has invalid owner_id ${String(record.owner_id)}`);
    } else if (seenIds.has(record.owner_id)) {
      issues.push(`duplicate owner_id ${record.owner_id}`);
    } else {
      seenIds.add(record.owner_id);
    }
    if (typeof record.legacy_path !== 'string' || !record.legacy_path) {
      issues.push(`${prefix} has invalid legacy_path`);
    } else if (seenPaths.has(record.legacy_path)) {
      issues.push(`duplicate legacy_path ${record.legacy_path}`);
    } else {
      seenPaths.add(record.legacy_path);
    }
    if (expectedById.has(record.owner_id) && expectedById.get(record.owner_id) !== record.legacy_path) {
      issues.push(`owner ${record.owner_id} legacy_path must be ${expectedById.get(record.owner_id)}`);
    }
    if (typeof record.legacy_path === 'string' && !expectedPaths.has(record.legacy_path)) {
      issues.push(`unexpected legacy_path ${record.legacy_path}`);
    }
    if (!statuses.has(record.status)) {
      issues.push(`owner ${record.owner_id} has invalid status ${String(record.status)}`);
    }
    if (!semanticClassifications.has(record.semantic_classification)) {
      issues.push(`owner ${record.owner_id} has invalid semantic_classification ${String(record.semantic_classification)}`);
    }
    if (!Array.isArray(record.dependency_ids)) {
      issues.push(`owner ${record.owner_id} dependency_ids must be an array`);
    }
    if (!Array.isArray(record.implementation_files)) {
      issues.push(`owner ${record.owner_id} implementation_files must be an array`);
    }
    if (terminalStatuses.has(record.status)) {
      if (!Number.isInteger(record.selected_test_count) || record.selected_test_count <= 0) {
        issues.push(`owner ${record.owner_id} terminal status requires a nonzero selected_test_count`);
      }
      for (const field of ['e2e_command', 'e2e_result', 'evidence_file']) {
        if (isBlank(record[field])) {
          issues.push(`owner ${record.owner_id} terminal status requires ${field}`);
        }
      }
      if (record.status === 'passed' && /(?:^|\/)(?:ranges|partitions?)(?:\/|$)|\b(?:range|partition)\b/i.test(`${record.evidence_file ?? ''}\n${record.e2e_command ?? ''}`)) {
        issues.push(`owner ${record.owner_id} passed evidence must name a row-level owner record, not only a partition or range report`);
      }
      if (existingEvidenceFiles && !existingEvidenceFiles.has(record.evidence_file)) {
        issues.push(`owner ${record.owner_id} evidence_file does not exist: ${record.evidence_file}`);
      }
    }
  }

  for (const { owner_id, legacy_path } of allocation) {
    if (!seenIds.has(owner_id)) {
      issues.push(`missing owner_id ${owner_id}`);
    }
    if (!seenPaths.has(legacy_path)) {
      issues.push(`missing legacy_path ${legacy_path}`);
    }
  }
  if (records.length !== allocation.length) {
    issues.push(`ledger must contain exactly ${allocation.length} records, found ${records.length}`);
  }

  return issues.sort();
};

export const createOpenRecord = ({ owner_id, legacy_path }) => ({
  owner_id,
  legacy_path,
  status: 'open',
  dependency_ids: [],
  historical_revision_path_line: '',
  full_caller_route_registry_chain: '',
  semantic_classification: 'unproven',
  final_owner: '',
  active_consumer: '',
  active_path: '',
  sealed_public_dto: '',
  implementation_files: [],
  e2e_command: '',
  selected_test_count: 0,
  e2e_result: '',
  rejection_unknown_recovery: '',
  authorization: '',
  secret_redaction: '',
  recovery_idempotency: '',
  legacy_residual: '',
  technical_gate_attestation: '',
  windows_x64_evidence: '',
  evidence_file: '',
  timestamp: '',
});

const scriptPath = fileURLToPath(import.meta.url);
if (process.argv[1] && path.resolve(process.argv[1]) === scriptPath) {
  const root = path.resolve(path.dirname(scriptPath), '..');
  const [ledgerContent, allocationContent] = await Promise.all([
    readFile(path.join(root, 'docs/architecture/runtime-host-e2e/owner-closure-ledger.md'), 'utf8'),
    readFile(path.join(root, 'docs/architecture/runtime-host-e2e/coverage-plan.md'), 'utf8'),
  ]);
  const { records } = parseLedgerRecords(ledgerContent);
  const terminalEvidenceFiles = await Promise.all(records
    .filter((record) => terminalStatuses.has(record.status))
    .map(async (record) => {
      try {
        await access(path.join(root, record.evidence_file));
        return record.evidence_file;
      } catch {
        return null;
      }
    }));
  const issues = validateOwnerClosureLedger({
    ledgerContent,
    allocationContent,
    existingEvidenceFiles: new Set(terminalEvidenceFiles.filter(Boolean)),
  });
  if (issues.length > 0) {
    console.error(issues.join('\n'));
    process.exitCode = 1;
  } else {
    console.log('owner closure ledger: 589 records validated');
  }
}
