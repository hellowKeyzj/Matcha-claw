import { execFile as execFileCallback } from 'node:child_process';
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';
import {
  assertTerminalReceiptProjection,
  parseJsonlRecords,
  selectReadyOwners,
  validateOwnerSchedulerBoundaries,
} from '../../scripts/owner-ready-scheduler.mjs';
import { integrateOwnerClosureReceipt } from '../../scripts/integrate-owner-closure-receipt.mjs';
import { seedOwnerClosureReceipts } from '../../scripts/seed-owner-closure-receipts.mjs';
import { validateOwnerClosureLedger } from '../../scripts/validate-owner-closure-ledger.mjs';

const execFile = promisify(execFileCallback);

const record = (overrides: Record<string, unknown> = {}) => ({
  owner_id: '001',
  legacy_path: 'runtime-host/example.ts',
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
  ...overrides,
});

const ledger = (records: Record<string, unknown>[]) => [
  '# Owner Closure Ledger',
  '',
  '```jsonl',
  ...records.map((entry) => JSON.stringify(entry)),
  '```',
].join('\n');

const allocation = (paths: string[]) => [
  '# Coverage',
  '',
  '| ID | Owner source | E2E partition / evidence file | Status |',
  '|---:|---|---|---|',
  ...paths.map((entry, index) => `| ${String(index + 1).padStart(3, '0')} | \`${entry}\` | partition / evidence.md | |`),
].join('\n');

describe('owner closure ledger validation', () => {
  it('accepts the checked-in nonterminal ledger', async () => {
    const root = process.cwd();
    const [ledgerContent, allocationContent] = await Promise.all([
      readFile(path.join(root, 'docs/architecture/runtime-host-e2e/owner-closure-ledger.md'), 'utf8'),
      readFile(path.join(root, 'docs/architecture/runtime-host-e2e/coverage-plan.md'), 'utf8'),
    ]);

    expect(validateOwnerClosureLedger({ ledgerContent, allocationContent })).toEqual([]);
  });

  it('rejects duplicate IDs, missing IDs, and mismatched paths', () => {
    const issues = validateOwnerClosureLedger({
      ledgerContent: ledger([
        record(),
        record({ legacy_path: 'runtime-host/other.ts' }),
      ]),
      allocationContent: allocation(['runtime-host/example.ts', 'runtime-host/other.ts']),
    });

    expect(issues.join('\n')).toMatch(/duplicate owner_id 001/);
    expect(issues.join('\n')).toMatch(/missing owner_id 002/);
    expect(issues.join('\n')).toMatch(/owner 001 legacy_path must be runtime-host\/example\.ts/);
  });

  it('rejects records with fields outside the closure contract', () => {
    const issues = validateOwnerClosureLedger({
      ledgerContent: ledger([record({ historicalNarrative: 'not part of the machine ledger' })]),
      allocationContent: allocation(['runtime-host/example.ts']),
    });

    expect(issues).toContain('ledger record 1 has unexpected historicalNarrative');
  });

  it('rejects terminal rows without a complete current E2E receipt', () => {
    const issues = validateOwnerClosureLedger({
      ledgerContent: ledger([record({ status: 'passed' })]),
      allocationContent: allocation(['runtime-host/example.ts']),
    });

    expect(issues).toContain('owner 001 terminal status requires a nonzero selected_test_count');
    expect(issues).toContain('owner 001 terminal status requires e2e_command');
    expect(issues).toContain('owner 001 terminal status requires e2e_result');
    expect(issues).toContain('owner 001 terminal status requires evidence_file');
  });

  it('rejects terminal receipts that do not resolve their row-level evidence file', () => {
    const issues = validateOwnerClosureLedger({
      ledgerContent: ledger([record({
        status: 'passed',
        selected_test_count: 1,
        e2e_command: 'pnpm vitest run tests/unit/example.test.ts',
        e2e_result: 'passed',
        evidence_file: 'docs/architecture/runtime-host-e2e/owners/O-001.md',
      })]),
      allocationContent: allocation(['runtime-host/example.ts']),
      existingEvidenceFiles: new Set(),
    });

    expect(issues).toContain('owner 001 evidence_file does not exist: docs/architecture/runtime-host-e2e/owners/O-001.md');
  });

  it('rejects unrecognized terminal states and batch-only passed evidence', () => {
    const invalidStatus = validateOwnerClosureLedger({
      ledgerContent: ledger([record({ status: 'closed' })]),
      allocationContent: allocation(['runtime-host/example.ts']),
    });
    const batchOnly = validateOwnerClosureLedger({
      ledgerContent: ledger([record({
        status: 'passed',
        selected_test_count: 1,
        e2e_command: 'pnpm vitest run tests/e2e/ranges/001-030',
        e2e_result: 'passed',
        evidence_file: 'docs/architecture/runtime-host-e2e/ranges/001-030.md',
      })]),
      allocationContent: allocation(['runtime-host/example.ts']),
    });

    expect(invalidStatus).toContain('owner 001 has invalid status closed');
    expect(batchOnly).toContain('owner 001 passed evidence must name a row-level owner record, not only a partition or range report');
  });
});

describe('owner closure receipt integration', () => {
  it('replaces only the matching open ledger row with a schema-valid receipt', async () => {
    const directory = await mkdtemp(path.join(tmpdir(), 'owner-closure-receipt-'));
    const receiptDirectory = path.join(directory, 'receipts');
    const evidencePath = path.join(directory, 'O-001.md');
    const receiptPath = path.join(receiptDirectory, 'O-001.json');
    await mkdir(receiptDirectory);
    await Promise.all([
      writeFile(evidencePath, '# O-001\n'),
      writeFile(receiptPath, JSON.stringify(record({
        status: 'passed',
        selected_test_count: 1,
        e2e_command: 'pnpm vitest run tests/unit/example.test.ts',
        e2e_result: 'passed',
        evidence_file: evidencePath,
      }))),
    ]);

    const integrated = await integrateOwnerClosureReceipt({
      ledgerContent: ledger([record(), record({ owner_id: '002', legacy_path: 'runtime-host/other.ts' })]),
      allocationContent: allocation(['runtime-host/example.ts', 'runtime-host/other.ts']),
      receiptPath,
    });

    expect(parseJsonlRecords(integrated)).toEqual([
      expect.objectContaining({ owner_id: '001', status: 'passed', evidence_file: evidencePath }),
      record({ owner_id: '002', legacy_path: 'runtime-host/other.ts' }),
    ]);
  });

  it('rejects an immutable receipt that would overwrite a terminal owner', async () => {
    const directory = await mkdtemp(path.join(tmpdir(), 'owner-closure-receipt-'));
    const evidencePath = path.join(directory, 'O-001.md');
    const receiptPath = path.join(directory, 'O-001.json');
    await Promise.all([
      writeFile(evidencePath, '# O-001\n'),
      writeFile(receiptPath, JSON.stringify(record({
        status: 'passed',
        selected_test_count: 1,
        e2e_command: 'pnpm vitest run tests/unit/example.test.ts',
        e2e_result: 'passed',
        evidence_file: evidencePath,
      }))),
    ]);

    await expect(integrateOwnerClosureReceipt({
      ledgerContent: ledger([record({ owner_id: '001', status: 'deleted-no-go', selected_test_count: 1, e2e_command: 'pnpm vitest run old', e2e_result: 'passed', evidence_file: evidencePath })]),
      allocationContent: allocation(['runtime-host/example.ts']),
      receiptPath,
    })).rejects.toThrow('owner 001 already has a terminal ledger record');
  });

  it('seeds immutable receipts from existing terminal rows without rewriting the ledger', async () => {
    const directory = await mkdtemp(path.join(tmpdir(), 'owner-closure-seed-'));
    const receiptDirectory = path.join(directory, 'receipts');
    const evidencePath = path.join(directory, 'O-001.md');
    await writeFile(evidencePath, '# O-001\n');
    const sourceLedger = ledger([record({
      status: 'passed',
      selected_test_count: 1,
      e2e_command: 'pnpm vitest run tests/unit/example.test.ts',
      e2e_result: 'passed',
      evidence_file: evidencePath,
    })]);

    const seeded = await seedOwnerClosureReceipts({ ledgerContent: sourceLedger, receiptDirectory });

    expect(seeded).toEqual(['001']);
    await expect(readFile(path.join(receiptDirectory, 'O-001.json'), 'utf8')).resolves.toBe(`${JSON.stringify(parseJsonlRecords(sourceLedger)[0])}\n`);
  });

  it('rejects receipts whose row-level evidence belongs to another owner', async () => {
    const directory = await mkdtemp(path.join(tmpdir(), 'owner-closure-receipt-'));
    const evidencePath = path.join(directory, 'O-002.md');
    const receiptPath = path.join(directory, 'O-001.json');
    await Promise.all([
      writeFile(evidencePath, '# O-002\n'),
      writeFile(receiptPath, JSON.stringify(record({
        status: 'passed',
        selected_test_count: 1,
        e2e_command: 'pnpm vitest run tests/unit/example.test.ts',
        e2e_result: 'passed',
        evidence_file: evidencePath,
      }))),
    ]);

    await expect(integrateOwnerClosureReceipt({
      ledgerContent: ledger([record()]),
      allocationContent: allocation(['runtime-host/example.ts']),
      receiptPath,
    })).rejects.toThrow('owner 001 evidence_file must name O-001.md');
  });

  it('rejects receipts with invalid closure contract or missing evidence', async () => {
    const directory = await mkdtemp(path.join(tmpdir(), 'owner-closure-receipt-'));
    const receiptPath = path.join(directory, 'O-001.json');
    await writeFile(receiptPath, JSON.stringify(record({
      status: 'passed',
      selected_test_count: 0,
      e2e_command: 'pnpm vitest run tests/unit/example.test.ts',
      e2e_result: 'passed',
      evidence_file: path.join(directory, 'O-001.md'),
    })));

    await expect(integrateOwnerClosureReceipt({
      ledgerContent: ledger([record()]),
      allocationContent: allocation(['runtime-host/example.ts']),
      receiptPath,
    })).rejects.toThrow(/nonzero selected_test_count/);
  });
});

const schedulerRecord = (overrides: Record<string, unknown> = {}) => ({
  owner_id: '001',
  legacy_path: 'runtime-host/example.ts',
  status: 'open',
  dependency_ids: [],
  ...overrides,
});

const schedulerLedger = (records: Record<string, unknown>[]) => records.map((entry) => JSON.stringify(entry)).join('\n');

const boundaries = (owners: Record<string, string[]>, writeSeams: Record<string, { protected_paths: string[] }> = {}) => ({
  version: 2,
  owners: Object.fromEntries(Object.entries(owners).map(([ownerId, writes]) => [ownerId, { writes }])),
  write_seams: Object.fromEntries(Object.entries(writeSeams).map(([seamId, seam]) => [seamId, {
    kind: 'exclusive',
    protected_paths: seam.protected_paths,
    description: `${seamId} writes`,
  }])),
});

describe('owner ready scheduler', () => {
  it('rejects terminal ledger records that lack an identical immutable receipt', () => {
    const terminal = schedulerRecord({ owner_id: '001', status: 'passed' });

    expect(() => assertTerminalReceiptProjection({
      ledgerContent: schedulerLedger([terminal]),
      receipts: new Map(),
    })).toThrow('owner 001 terminal ledger record has no immutable receipt');
    expect(() => assertTerminalReceiptProjection({
      ledgerContent: schedulerLedger([terminal]),
      receipts: new Map([['001', { ...terminal, status: 'deleted-no-go' }]]),
    })).toThrow('owner 001 ledger record does not match immutable receipt');
  });

  it('selects open owners with only terminal dependencies in stable owner order', () => {
    const ready = selectReadyOwners({
      ledgerContent: schedulerLedger([
        schedulerRecord({ owner_id: '003', dependency_ids: ['001', '002'] }),
        schedulerRecord({ owner_id: '001', status: 'passed' }),
        schedulerRecord({ owner_id: '002', status: 'deleted-no-go' }),
        schedulerRecord({ owner_id: '004', status: 'implementing' }),
      ]),
      boundaries: boundaries({ '001': [], '002': [], '003': [], '004': [] }),
    });

    expect(ready).toEqual({ ready_owner_ids: ['003'] });
  });

  it('does not select owners with unknown or nonterminal dependencies', () => {
    const ready = selectReadyOwners({
      ledgerContent: schedulerLedger([
        schedulerRecord({ owner_id: '001', dependency_ids: ['999'] }),
        schedulerRecord({ owner_id: '002', dependency_ids: ['003'] }),
        schedulerRecord({ owner_id: '003', status: 'rerunning' }),
      ]),
      boundaries: boundaries({ '001': [], '002': [], '003': [] }),
    });

    expect(ready).toEqual({ ready_owner_ids: [] });
  });

  it('selects all independent owners concurrently', () => {
    const ready = selectReadyOwners({
      ledgerContent: schedulerLedger([
        schedulerRecord({ owner_id: '002' }),
        schedulerRecord({ owner_id: '001' }),
      ]),
      boundaries: boundaries({ '001': [], '002': [] }),
    });

    expect(ready).toEqual({ ready_owner_ids: ['001', '002'] });
  });

  it('excludes peers on a seam held by active work', () => {
    const ready = selectReadyOwners({
      ledgerContent: schedulerLedger([
        schedulerRecord({ owner_id: '001' }),
        schedulerRecord({ owner_id: '002', status: 'implementing' }),
        schedulerRecord({ owner_id: '003' }),
      ]),
      boundaries: boundaries(
        { '001': ['cargo-public'], '002': ['cargo-public'], '003': [] },
        { 'cargo-public': { protected_paths: ['runtime-host/Cargo.toml'] } },
      ),
    });

    expect(ready).toEqual({ ready_owner_ids: ['003'] });
  });

  it('serializes owners on an inactive shared seam in deterministic order', () => {
    const ready = selectReadyOwners({
      ledgerContent: schedulerLedger([
        schedulerRecord({ owner_id: '002' }),
        schedulerRecord({ owner_id: '001' }),
        schedulerRecord({ owner_id: '003' }),
      ]),
      boundaries: boundaries(
        { '001': ['openclaw-protocol'], '002': ['openclaw-protocol'], '003': [] },
        { 'openclaw-protocol': { protected_paths: ['runtime-host/integrations/openclaw/src/lib.rs'] } },
      ),
    });

    expect(ready).toEqual({ ready_owner_ids: ['001', '003'] });
  });

  it('rejects malformed v2 manifests before scheduling', () => {
    const records = [schedulerRecord({ owner_id: '001' })];
    const malformed = {
      version: 2,
      owners: { '001': { writes: ['unknown-seam'] }, '999': { writes: [] } },
      write_seams: {
        first: { kind: 'exclusive', protected_paths: ['runtime-host/Cargo.toml'], description: 'first' },
        second: { kind: 'exclusive', protected_paths: ['runtime-host/Cargo.toml'], description: '' },
      },
    };

    expect(validateOwnerSchedulerBoundaries({ records, boundaries: malformed })).toEqual(expect.arrayContaining([
      'manifest has unknown owner 999',
      'owner 001 assigns unknown write seam unknown-seam',
      'exclusive write seams first and second duplicate protected path runtime-host/Cargo.toml',
      'write seam second must declare a description',
    ]));
    expect(() => selectReadyOwners({ ledgerContent: schedulerLedger(records), boundaries: malformed }))
      .toThrow(/Invalid owner scheduler boundary manifest/);
  });

  it('requires exact v2 manifest coverage for the checked-in 589-owner ledger', async () => {
    const root = process.cwd();
    const [ledgerContent, manifestContent] = await Promise.all([
      readFile(path.join(root, 'docs/architecture/runtime-host-e2e/owner-closure-ledger.md'), 'utf8'),
      readFile(path.join(root, 'docs/architecture/runtime-host-e2e/owner-shared-write-boundaries.json'), 'utf8'),
    ]);
    const records = parseJsonlRecords(ledgerContent);
    const manifest = JSON.parse(manifestContent);

    expect(records).toHaveLength(589);
    expect(manifest.version).toBe(2);
    expect(Object.keys(manifest.owners)).toHaveLength(589);
    expect(Object.keys(manifest.owners).sort()).toEqual(records.map(({ owner_id }) => owner_id).sort());
    expect(validateOwnerSchedulerBoundaries({ records, boundaries: manifest })).toEqual([]);
    const readyOwnerIds = selectReadyOwners({ ledgerContent, boundaries: manifest }).ready_owner_ids;
    expect(readyOwnerIds).not.toEqual([]);
    expect(readyOwnerIds).toEqual([...readyOwnerIds].sort());
    expect(readyOwnerIds.every((ownerId) => records.find((record) => record.owner_id === ownerId)?.status === 'open')).toBe(true);
  });

  it('declares exclusive seams over current shared Rust contracts', async () => {
    const root = process.cwd();
    const manifest = JSON.parse(await readFile(path.join(root, 'docs/architecture/runtime-host-e2e/owner-shared-write-boundaries.json'), 'utf8'));

    expect(manifest.write_seams).toEqual(expect.objectContaining({
      'workspace-membership': expect.objectContaining({ kind: 'exclusive', protected_paths: ['runtime-host/Cargo.toml'] }),
      'host-composition': expect.objectContaining({ kind: 'exclusive', protected_paths: ['runtime-host/host/src/lib.rs'] }),
      'openclaw-public-contract': expect.objectContaining({ kind: 'exclusive', protected_paths: ['runtime-host/integrations/openclaw/src/lib.rs'] }),
      'matcha-agent-public-contract': expect.objectContaining({ kind: 'exclusive', protected_paths: ['runtime-host/integrations/matcha-agent/src/lib.rs'] }),
    }));
  });

  it('emits deterministic JSON through the CLI', async () => {
    const directory = await mkdtemp(path.join(tmpdir(), 'owner-ready-scheduler-'));
    const ledgerPath = path.join(directory, 'ledger.jsonl');
    const boundariesPath = path.join(directory, 'boundaries.json');
    const receiptsDirectory = path.join(directory, 'receipts');
    await mkdir(receiptsDirectory);
    await Promise.all([
      writeFile(ledgerPath, schedulerLedger([
        schedulerRecord({ owner_id: '002' }),
        schedulerRecord({ owner_id: '001' }),
      ])),
      writeFile(boundariesPath, JSON.stringify(boundaries({ '001': [], '002': [] }))),
    ]);

    const { stdout } = await execFile(process.execPath, [
      'scripts/owner-ready-scheduler.mjs',
      '--ledger', ledgerPath,
      '--boundaries', boundariesPath,
      '--receipts-directory', receiptsDirectory,
    ], { cwd: process.cwd() });

    expect(JSON.parse(stdout)).toEqual({ ready_owner_ids: ['001', '002'] });
  });
});
