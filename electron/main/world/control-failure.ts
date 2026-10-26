import type { Failure, FailureStage } from '../../../src/types/world';
import { isJsonValue, isRecord } from '../runtime-host-delivery/transport/client';

const STAGES: readonly FailureStage[] = ['decode', 'admission', 'read', 'parse', 'generate', 'resolve', 'validate', 'compile', 'prepare', 'execute', 'verify', 'commit', 'activate', 'migrate', 'drain', 'stop', 'recover', 'disclose'];
const RECOVERY = ['none', 'correct_input', 'refresh', 'rebase', 'supply_dependency', 'restore_credential', 'retry_read', 'resume_operation', 'read_commit', 'read_transfer', 'inspect_effect', 'request_evidence', 'manual_review'];
const DETAILS = ['upload', 'input', 'authorization', 'release', 'query', 'operation', 'transport', 'not_configured', 'not_found', 'revision_conflict', 'unsupported_operation', 'internal_fault'];

export function parseWorldControlFailure(value: unknown): Pick<Failure, 'code' | 'stage' | 'diagnosticId' | 'recovery' | 'details'> | undefined {
  if (!isRecord(value) || !Object.keys(value).every((key) => ['code', 'stage', 'diagnosticId', 'message', 'recovery', 'details', 'operationId', 'runId', 'stepId'].includes(key))
    || typeof value.code !== 'string' || !/^[A-Za-z0-9_.:-]{1,256}$/.test(value.code)
    || typeof value.diagnosticId !== 'string' || !/^[A-Za-z0-9_.:-]{1,256}$/.test(value.diagnosticId)
    || !STAGES.includes(value.stage as FailureStage) || !isRecord(value.recovery) || !RECOVERY.includes(String(value.recovery.kind))
    || !isRecord(value.details) || !DETAILS.includes(String(value.details.kind))
    || !isJsonValue(value.recovery, new Set()) || !isJsonValue(value.details, new Set())) return undefined;
  return { code: value.code, stage: value.stage as FailureStage, diagnosticId: value.diagnosticId,
    recovery: value.recovery as Failure['recovery'], details: value.details as Failure['details'] };
}
