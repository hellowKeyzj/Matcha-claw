import { createHash } from 'node:crypto';
import type { AgentsTransport } from '../runtime-host-delivery/products/agents';
import type { SealedSkillsTransport } from '../runtime-host-delivery/transport/skills/sealed';
import type { CallLogTransport } from '../runtime-host-delivery/transport/call-log';
import { isSkillsCallReceipt } from '../runtime-host-delivery/transport/skills/management';
import { waitForCallRecord, type SubscribeCalls } from '../../../src/types/call-log/wait';
import type { CloudPackageOperationErrorCode, CloudPackageOperationRequests, CloudPackageOperationResults, CloudPackageOperationKind } from '../../../src/types/cloud-package-operation';
import type { CloudPackageLocalDownload, CloudPackageVersion, CloudSealedCloudKey } from './types';
import type { CloudPackageUpload } from './client';
import type { PreparedPackageInstall } from './package-authorization';

export type PackageOperationTransports = Readonly<{
  agentsTransport: AgentsTransport;
  sealedSkillsTransport: SealedSkillsTransport;
  callLogTransport: CallLogTransport;
  subscribeCalls: SubscribeCalls;
  packageChanged: (operationId: string) => void;
}>;
export class PackageOperationError extends Error {
  constructor(readonly code: CloudPackageOperationErrorCode, readonly status: number, message: string) { super(message); }
}
export type PackageOperationSession = Readonly<{
  assertCurrent(): void;
  signal: AbortSignal;
  download(request: CloudPackageOperationRequests['download']): Promise<CloudPackageLocalDownload>;
  fetchKey(): Promise<CloudSealedCloudKey>;
  upload(upload: CloudPackageUpload): Promise<CloudPackageVersion>;
  prepare(request: CloudPackageOperationRequests['install']): Promise<PreparedPackageInstall>;
  bind(callId: string, prepared: PreparedPackageInstall): void;
  release(prepared: PreparedPackageInstall): void;
}>;

export async function executePackageOperation<K extends CloudPackageOperationKind>(
  kind: K, request: CloudPackageOperationRequests[K], session: PackageOperationSession, transports: PackageOperationTransports,
): Promise<CloudPackageOperationResults[K]> {
  switch (kind) {
    case 'download': return publicDownload(await session.download(request as CloudPackageOperationRequests['download'])) as CloudPackageOperationResults[K];
    case 'install': {
      const prepared = await session.prepare(request as CloudPackageOperationRequests['install']);
      try {
        session.assertCurrent();
        const installed = prepared.cloudMetadata.packageType === 'agent'
          ? await transports.agentsTransport.execute(agentRequest('install', undefined, { packagePath: prepared.download.packagePath, cloudMetadata: prepared.cloudMetadata }))
          : await transports.sealedSkillsTransport.install({ packagePath: prepared.download.packagePath, cloudMetadata: prepared.cloudMetadata });
        if (installed.status !== 202 || !isSkillsCallReceipt(installed.body)) {
          throw new PackageOperationError(installed.status === 409 || installed.status === 422 || installed.status === 400 ? 'nativeRejected' : 'outcomeUnknown', installed.status >= 400 ? installed.status : 502, 'Package installation was not admitted; check the installed packages before retrying');
        }
        // Keep the original native receipt even when the session changes after admission.
        session.bind(installed.body.callId, prepared);
        return { ...publicDownload(prepared.download), install: installed.body } as CloudPackageOperationResults[K];
      } finally { session.release(prepared); }
    }
    case 'confirmSealedSkillUpload': {
      const { callId } = request as CloudPackageOperationRequests['confirmSealedSkillUpload'];
      session.assertCurrent();
      const call = await transports.callLogTransport.get({ callId });
      session.assertCurrent();
      if (call.status !== 200 || !('module' in call.body) || call.body.callId !== callId || call.body.module !== 'skills'
        || call.body.command !== 'sealedSkills.exportCloud' || call.body.status !== 'succeeded'
        || call.body.detail.access !== 'read' || call.body.detail.outcome !== 'accepted') {
        throw new PackageOperationError('exportUnconfirmed', 409, 'Cloud skill export is not confirmed');
      }
      const exported = await transports.sealedSkillsTransport.exportCloudResult(callId);
      session.assertCurrent();
      if (exported.status !== 200 || !('result' in exported.body) || exported.body.callId !== callId
        || exported.body.command !== 'sealedSkills.exportCloud' || exported.body.result.kind !== 'sealedCloudExport'
        || exported.body.result.skillKey !== call.body.detail.skillKey) {
        throw new PackageOperationError('artifactUnavailable', 502, 'Cloud skill export artifact is unavailable');
      }
      const { fileName, packageSha256, packageBase64 } = exported.body.result;
      return await session.upload(checkedUpload(fileName, packageSha256, packageBase64, 10 * 1024 * 1024)) as CloudPackageOperationResults[K];
    }
    case 'uploadSealedAgent': {
      const { agentId } = request as CloudPackageOperationRequests['uploadSealedAgent'];
      const cloudKey = await session.fetchKey();
      session.assertCurrent();
      const exported = await transports.agentsTransport.execute(agentRequest('exportCloud', agentId, { cloudPublicKey: cloudKey.publicKey, cloudKeyId: cloudKey.keyId }));
      if (exported.status !== 202 || !isSkillsCallReceipt(exported.body)) throw new PackageOperationError(exported.status === 409 || exported.status === 422 ? 'nativeRejected' : 'outcomeUnknown', 502, 'Agent package export admission is not confirmed; check its status before retrying');
      const callId = exported.body.callId;
      const call = await waitForCallRecord(exported.body, 'subagents', async (id) => {
        session.assertCurrent();
        const observed = await transports.callLogTransport.get({ callId: id });
        session.assertCurrent();
        if (observed.status !== 200 || !('module' in observed.body)) throw new PackageOperationError('outcomeUnknown', 502, 'Agent package export outcome is unknown; check its status before retrying');
        return observed.body;
      }, { signal: session.signal }, transports.subscribeCalls);
      session.assertCurrent();
      if (call.command !== 'subagents.package.exportCloud' || call.detail.endpoint !== 'openclaw:local' || (call.detail.agentId !== null && call.detail.agentId !== agentId)
        || call.status !== 'succeeded' || call.detail.outcome !== 'packageExported') throw new PackageOperationError('exportUnconfirmed', 409, 'Agent package cloud export is not confirmed');
      const completed = await transports.agentsTransport.result({ callId, operationId: 'subagents.package.exportCloud', endpoint: endpoint(), agentId });
      session.assertCurrent();
      if (completed.status !== 200 || !record(completed.body) || completed.body.callId !== callId
        || completed.body.operationId !== 'subagents.package.exportCloud' || completed.body.status !== 200
        || !record(completed.body.body) || completed.body.body.success !== true || !record(completed.body.body.package)
        || completed.body.body.package.agentId !== agentId) throw new PackageOperationError('artifactUnavailable', 502, 'Agent package export result is unavailable');
      const artifact = await transports.agentsTransport.exportCloudArtifact({ callId, operationId: 'subagents.package.exportCloud', endpoint: endpoint(), agentId });
      session.assertCurrent();
      if (artifact.status !== 200 || !record(artifact.body) || artifact.body.callId !== callId || artifact.body.operationId !== 'subagents.package.exportCloud'
        || !record(artifact.body.package) || artifact.body.package.agentId !== agentId) throw new PackageOperationError('artifactUnavailable', 502, 'Agent package export artifact is unavailable');
      const pkg = artifact.body.package;
      const metadata = completed.body.body.package;
      if (pkg.fileName !== metadata.fileName || pkg.size !== metadata.size || pkg.exportedAtMs !== metadata.exportedAtMs
        || typeof pkg.fileName !== 'string' || typeof pkg.packageSha256 !== 'string' || typeof pkg.packageBase64 !== 'string'
        || typeof pkg.size !== 'number') throw new PackageOperationError('artifactInvalid', 502, 'Agent package export artifact is invalid');
      return await session.upload(checkedUpload(pkg.fileName, pkg.packageSha256, pkg.packageBase64, 256 * 1024, pkg.size)) as CloudPackageOperationResults[K];
    }
  }
  throw new Error('Invalid cloud package operation kind');
}

function checkedUpload(fileName: string, sha256: string, base64: string, limit: number, size?: number): CloudPackageUpload {
  if (base64.length === 0 || base64.length > Math.ceil(limit / 3) * 4 || base64.length % 4 !== 0
    || !/^[A-Za-z0-9+/]+={0,2}$/.test(base64) || !/^[a-f0-9]{64}$/i.test(sha256)
    || !fileName || fileName.length > 512 || /[\\/\0]/.test(fileName)) throw new PackageOperationError('artifactInvalid', 502, 'Cloud package export artifact is invalid');
  const packageBytes = Buffer.from(base64, 'base64');
  if (packageBytes.length === 0 || packageBytes.length > limit || (size !== undefined && packageBytes.length !== size)
    || packageBytes.toString('base64') !== base64 || createHash('sha256').update(packageBytes).digest('hex') !== sha256) {
    throw new PackageOperationError('artifactInvalid', 502, 'Cloud package export artifact is invalid');
  }
  return { fileName, packageBytes };
}
function publicDownload(value: CloudPackageLocalDownload): CloudPackageOperationResults['download'] {
  return { packageVersionId: value.packageVersionId, filename: value.filename, bytes: value.bytes, packageSha256: value.packageSha256,
    ...(value.contentType === undefined ? {} : { contentType: value.contentType }) };
}
function endpoint() { return { kind: 'native-runtime', runtimeAdapterId: 'openclaw', runtimeInstanceId: 'local' } as const; }
function agentRequest(operation: 'install' | 'exportCloud', agentId: string | undefined, input: Record<string, unknown>) {
  const ep = endpoint();
  return { id: 'subagent.management', operationId: `subagents.package.${operation}`, scope: { kind: 'agent', endpoint: ep, agentId: 'main' },
    target: { kind: 'subagent', ...(agentId === undefined ? {} : { subagentId: agentId }) },
    input: { kind: operation === 'install' ? 'packageInstall' : 'packageExportCloud', endpoint: ep, ...(agentId === undefined ? {} : { agentId }), ...input } };
}
function record(value: unknown): value is Record<string, unknown> { return value !== null && typeof value === 'object' && !Array.isArray(value); }
