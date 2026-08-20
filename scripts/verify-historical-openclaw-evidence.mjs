#!/usr/bin/env node

import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const MANIFEST_FILE_NAME = 'manifest.json';
const SIGNATURE_FILE_NAME = 'manifest.sig';
const RECEIPT_VERSION = 1;
const MANIFEST_FORMAT_VERSION = 2;
const MAX_RELATIVE_PATH_LENGTH = 512;
const MAX_TEXT_LENGTH = 4096;
const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const SHA512_PATTERN = /^[a-f0-9]{128}$/;
const VERSION_PATTERN = /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/;
const REVISION_PATTERN = /^[a-f0-9]{40}(?:[a-f0-9]{24})?$/;
const PLATFORM_PATTERN = /^[a-z0-9]+(?:-[a-z0-9][a-z0-9._-]*)+$/;
const SUPPORTED_PLATFORMS = new Set([
  'darwin-arm64',
  'darwin-x64',
  'linux-arm64',
  'linux-x64',
  'win32-arm64',
  'win32-x64',
]);
const IDENTIFIER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]*$/;
const PATH_SEGMENT_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._@+-]*$/;
const BASE64_PATTERN = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;
const UTC_TIMESTAMP_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/;
const IMPORT_STAGING_PREFIX = '.historical-openclaw-evidence-import-';
const PLATFORM_EVIDENCE_FORMATS = Object.freeze({
  darwin: Object.freeze({
    certificate: 'x509-chain',
    codesign: 'apple-codesign',
    notarization: 'apple-notarization',
  }),
  win32: Object.freeze({
    certificate: 'x509-chain',
    authenticode: 'authenticode',
  }),
  linux: Object.freeze({}),
});

export class EvidenceVerificationError extends Error {
  constructor(code) {
    super(code);
    this.code = code;
  }
}

function reject(code) {
  throw new EvidenceVerificationError(code);
}

function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function requireRecord(value, code = 'MANIFEST_INVALID') {
  if (!isRecord(value)) reject(code);
  return value;
}

function requireString(value, code = 'MANIFEST_INVALID', maximumLength = MAX_TEXT_LENGTH) {
  if (
    typeof value !== 'string' ||
    value.trim() === '' ||
    value.length > maximumLength
  ) {
    reject(code);
  }
  return value;
}

function requireExactKeys(record, allowedKeys) {
  const allowed = new Set(allowedKeys);
  for (const key of Object.keys(record)) {
    if (!allowed.has(key)) reject('MANIFEST_INVALID');
  }
  for (const key of allowedKeys) {
    if (!(key in record)) reject('MANIFEST_INVALID');
  }
}

function requireIdentifier(value) {
  const identifier = requireString(value, 'MANIFEST_INVALID', 128);
  if (!IDENTIFIER_PATTERN.test(identifier)) reject('MANIFEST_INVALID');
  return identifier;
}

function requireSha256(value) {
  const hash = requireString(value).toLowerCase();
  if (!SHA256_PATTERN.test(hash)) reject('MANIFEST_INVALID');
  return hash;
}

function requireSha512(value) {
  const hash = requireString(value).toLowerCase();
  if (!SHA512_PATTERN.test(hash)) reject('MANIFEST_INVALID');
  return hash;
}

function requireVersion(value) {
  const version = requireString(value, 'MANIFEST_INVALID', 128);
  if (!VERSION_PATTERN.test(version)) reject('MANIFEST_INVALID');
  return version;
}

function requireRevision(value) {
  const revision = requireString(value, 'MANIFEST_INVALID', 64).toLowerCase();
  if (!REVISION_PATTERN.test(revision)) reject('MANIFEST_INVALID');
  return revision;
}

function requirePlatform(value) {
  const platform = requireString(value, 'MANIFEST_INVALID', 128);
  if (!PLATFORM_PATTERN.test(platform) || !SUPPORTED_PLATFORMS.has(platform)) {
    reject('MANIFEST_INVALID');
  }
  return platform;
}

function requireUtcTimestamp(value) {
  const timestamp = requireString(value, 'MANIFEST_INVALID', 32);
  if (!UTC_TIMESTAMP_PATTERN.test(timestamp)) reject('MANIFEST_INVALID');

  const milliseconds = Date.parse(timestamp);
  const canonicalTimestamp = timestamp.includes('.')
    ? timestamp
    : `${timestamp.slice(0, -1)}.000Z`;
  if (Number.isNaN(milliseconds) || new Date(milliseconds).toISOString() !== canonicalTimestamp) {
    reject('MANIFEST_INVALID');
  }
  return timestamp;
}

function requireHttpsUri(value) {
  const sourceUri = requireString(value, 'MANIFEST_INVALID', 2048);
  let parsedSourceUri;
  try {
    parsedSourceUri = new URL(sourceUri);
  } catch {
    reject('MANIFEST_INVALID');
  }
  if (
    parsedSourceUri.protocol !== 'https:' ||
    parsedSourceUri.username ||
    parsedSourceUri.password
  ) {
    reject('MANIFEST_INVALID');
  }
  return sourceUri;
}

function requireRelativePath(value) {
  const relativePath = requireString(value, 'MANIFEST_INVALID', MAX_RELATIVE_PATH_LENGTH);
  if (
    relativePath.includes('\\') ||
    path.posix.isAbsolute(relativePath) ||
    path.win32.isAbsolute(relativePath) ||
    path.posix.normalize(relativePath) !== relativePath
  ) {
    reject('PATH_OUTSIDE_BUNDLE');
  }

  const segments = relativePath.split('/');
  if (
    segments.some(
      (segment) =>
        segment === '' ||
        segment === '.' ||
        segment === '..' ||
        !PATH_SEGMENT_PATTERN.test(segment),
    )
  ) {
    reject('PATH_OUTSIDE_BUNDLE');
  }
  return relativePath;
}

function requireFileHashes(record) {
  return {
    sha256: requireSha256(record.sha256),
    sha512: requireSha512(record.sha512),
  };
}

function createFileReferenceRegistry() {
  const fileReferencesByPath = new Set();

  return {
    register(reference) {
      if (fileReferencesByPath.has(reference.path)) reject('MANIFEST_INVALID');
      fileReferencesByPath.add(reference.path);
      return reference;
    },
  };
}

function validateFileReference(value, fileRegistry) {
  const reference = requireRecord(value);
  requireExactKeys(reference, ['path', 'sha256', 'sha512']);
  return fileRegistry.register({
    path: requireRelativePath(reference.path),
    ...requireFileHashes(reference),
  });
}

function requireDigestPair(value) {
  const digest = requireRecord(value);
  requireExactKeys(digest, ['sha256', 'sha512']);
  return requireFileHashes(digest);
}

function validateArchiveBinding(value, archive) {
  const binding = requireRecord(value);
  requireExactKeys(binding, ['sha256', 'sha512']);
  if (
    requireSha256(binding.sha256) !== archive.sha256 ||
    requireSha512(binding.sha512) !== archive.sha512
  ) {
    reject('ARTIFACT_EVIDENCE_INVALID');
  }
  return { sha256: archive.sha256, sha512: archive.sha512 };
}

function validateImmutableLocator(value, archive, openclawVersion) {
  const locator = requireRecord(value);
  requireExactKeys(locator, ['kind', 'id', 'uri', 'version', 'openclawVersion', 'archive']);
  const kind = requireString(locator.kind, 'MANIFEST_INVALID', 64);
  if (!['release', 'registry'].includes(kind)) reject('MANIFEST_INVALID');
  requireIdentifier(locator.id);
  requireHttpsUri(locator.uri);
  requireVersion(locator.version);
  if (requireVersion(locator.openclawVersion) !== openclawVersion) reject('VERSION_MISMATCH');
  validateArchiveBinding(locator.archive, archive);
}

function validateArtifactSignature(value, archive, openclawVersion, fileRegistry) {
  const signature = requireRecord(value);
  requireExactKeys(signature, ['algorithm', 'keyId', 'version', 'file', 'archive']);
  if (requireString(signature.algorithm, 'MANIFEST_INVALID', 64) !== 'ed25519') {
    reject('MANIFEST_INVALID');
  }
  const keyId = requireIdentifier(signature.keyId);
  if (requireVersion(signature.version) !== openclawVersion) reject('VERSION_MISMATCH');
  const file = validateFileReference(signature.file, fileRegistry);
  validateArchiveBinding(signature.archive, archive);
  return { algorithm: 'ed25519', keyId, ...file };
}

function platformEvidenceFormats(platform) {
  const family = platform.split('-', 1)[0];
  const formats = PLATFORM_EVIDENCE_FORMATS[family];
  if (!formats) reject('MANIFEST_INVALID');
  return formats;
}

function validateExternalArtifactEvidence(
  value,
  expectedFormat,
  archive,
  openclawVersion,
  fileRegistry,
) {
  const evidence = requireRecord(value);
  requireExactKeys(evidence, ['format', 'version', 'record', 'archive']);
  if (requireString(evidence.format, 'MANIFEST_INVALID', 128) !== expectedFormat) {
    reject('MANIFEST_INVALID');
  }
  if (requireVersion(evidence.version) !== openclawVersion) reject('VERSION_MISMATCH');
  const record = validateFileReference(evidence.record, fileRegistry);
  validateArchiveBinding(evidence.archive, archive);
  return record;
}

function validatePlatformEvidence(value, platform, archive, openclawVersion, fileRegistry) {
  const evidence = requireRecord(value);
  const formats = platformEvidenceFormats(platform);
  const requiredFields = Object.keys(formats);
  requireExactKeys(evidence, ['artifactSignature', ...requiredFields]);
  const artifactSignature = validateArtifactSignature(
    evidence.artifactSignature,
    archive,
    openclawVersion,
    fileRegistry,
  );
  const externalEvidence = requiredFields.map((field) =>
    validateExternalArtifactEvidence(
      evidence[field],
      formats[field],
      archive,
      openclawVersion,
      fileRegistry,
    ),
  );
  return { artifactSignature, externalEvidence };
}

function validateBuildProvenance(
  value,
  archive,
  platform,
  openclawVersion,
  sourceRevision,
  sourceArchive,
  lockfile,
  fileRegistry,
) {
  const provenance = requireRecord(value);
  requireExactKeys(provenance, [
    'format',
    'version',
    'record',
    'sourceRevision',
    'sourceArchive',
    'dependencyLock',
    'dependencyDigest',
    'buildRun',
    'buildParameters',
    'target',
    'startedAt',
    'completedAt',
    'archive',
  ]);
  requireString(provenance.format, 'MANIFEST_INVALID', 128);
  if (requireVersion(provenance.version) !== openclawVersion) reject('VERSION_MISMATCH');
  const record = validateFileReference(provenance.record, fileRegistry);
  if (requireRevision(provenance.sourceRevision) !== sourceRevision) reject('VERSION_MISMATCH');
  validateArchiveBinding(provenance.sourceArchive, sourceArchive);
  validateArchiveBinding(provenance.dependencyLock, lockfile);
  const dependencyDigest = requireDigestPair(provenance.dependencyDigest);
  if (
    dependencyDigest.sha256 !== lockfile.sha256 ||
    dependencyDigest.sha512 !== lockfile.sha512
  ) {
    reject('BUILD_PROVENANCE_INVALID');
  }

  const buildRun = requireRecord(provenance.buildRun);
  requireExactKeys(buildRun, ['provider', 'workflow', 'runId', 'attempt', 'uri']);
  requireString(buildRun.provider, 'MANIFEST_INVALID', 128);
  requireString(buildRun.workflow, 'MANIFEST_INVALID', 512);
  requireIdentifier(buildRun.runId);
  if (!Number.isInteger(buildRun.attempt) || buildRun.attempt < 1 || buildRun.attempt > 1000000) {
    reject('MANIFEST_INVALID');
  }
  requireHttpsUri(buildRun.uri);

  const buildParameters = validateFileReference(provenance.buildParameters, fileRegistry);
  const target = requireRecord(provenance.target);
  requireExactKeys(target, ['platform']);
  if (requirePlatform(target.platform) !== platform) reject('BUILD_PROVENANCE_INVALID');

  const startedAt = requireUtcTimestamp(provenance.startedAt);
  const completedAt = requireUtcTimestamp(provenance.completedAt);
  if (Date.parse(completedAt) < Date.parse(startedAt)) reject('BUILD_PROVENANCE_INVALID');
  validateArchiveBinding(provenance.archive, archive);

  return { record, buildParameters };
}

function validatePlatformArchive(
  value,
  openclawVersion,
  sourceRevision,
  sourceArchive,
  lockfile,
  fileRegistry,
) {
  const archiveEntry = requireRecord(value);
  requireExactKeys(archiveEntry, [
    'platform',
    'openclawVersion',
    'archive',
    'payloads',
    'immutableLocator',
    'evidence',
    'buildProvenance',
  ]);
  const platform = requirePlatform(archiveEntry.platform);
  if (requireVersion(archiveEntry.openclawVersion) !== openclawVersion) {
    reject('VERSION_MISMATCH');
  }

  const archive = validateFileReference(archiveEntry.archive, fileRegistry);
  if (!Array.isArray(archiveEntry.payloads) || archiveEntry.payloads.length === 0) {
    reject('MANIFEST_INVALID');
  }
  const payloadIds = new Set();
  let hasOpenClawPackagePayload = false;
  const payloads = archiveEntry.payloads.map((payloadReference) => {
    const payload = requireRecord(payloadReference);
    requireExactKeys(payload, ['id', 'kind', 'file', 'openclawVersion', 'archive']);
    const id = requireIdentifier(payload.id);
    if (payloadIds.has(id)) reject('MANIFEST_INVALID');
    payloadIds.add(id);

    const kind = requireString(payload.kind, 'MANIFEST_INVALID', 128);
    if (!['openclaw-package', 'plugin-source', 'plugin-payload', 'runtime-payload'].includes(kind)) {
      reject('MANIFEST_INVALID');
    }
    if (kind === 'openclaw-package') hasOpenClawPackagePayload = true;
    if (requireVersion(payload.openclawVersion) !== openclawVersion) {
      reject('VERSION_MISMATCH');
    }
    validateArchiveBinding(payload.archive, archive);
    return { id, kind, ...validateFileReference(payload.file, fileRegistry) };
  });
  if (!hasOpenClawPackagePayload) reject('MANIFEST_INVALID');

  validateImmutableLocator(archiveEntry.immutableLocator, archive, openclawVersion);
  const { artifactSignature, externalEvidence } = validatePlatformEvidence(
    archiveEntry.evidence,
    platform,
    archive,
    openclawVersion,
    fileRegistry,
  );
  const buildProvenance = validateBuildProvenance(
    archiveEntry.buildProvenance,
    archive,
    platform,
    openclawVersion,
    sourceRevision,
    sourceArchive,
    lockfile,
    fileRegistry,
  );

  return {
    platform,
    openclawVersion,
    archive,
    payloads,
    artifactSignature,
    externalEvidence,
    buildProvenance,
  };
}

function validatePatch(value, openclawVersion, sourceRevision, fileRegistry) {
  const patch = requireRecord(value);
  const kind = requireString(patch.kind, 'MANIFEST_INVALID', 32);
  if (!['unmodified', 'patched'].includes(kind)) reject('MANIFEST_INVALID');
  requireExactKeys(patch, [
    'kind',
    'version',
    'sourceRevision',
    'input',
    'output',
    'executionRecord',
    'targetFiles',
    'patches',
  ]);
  if (requireVersion(patch.version) !== openclawVersion) reject('VERSION_MISMATCH');
  if (requireRevision(patch.sourceRevision) !== sourceRevision) reject('VERSION_MISMATCH');
  const input = validateFileReference(patch.input, fileRegistry);
  const output = validateFileReference(patch.output, fileRegistry);
  const executionRecord = validateFileReference(patch.executionRecord, fileRegistry);
  if (!Array.isArray(patch.targetFiles) || patch.targetFiles.length === 0) {
    reject('MANIFEST_INVALID');
  }

  const targetPaths = new Set();
  for (const targetFile of patch.targetFiles) {
    const target = requireRecord(targetFile);
    requireExactKeys(target, ['path', 'input', 'output']);
    const targetPath = requireRelativePath(target.path);
    if (targetPaths.has(targetPath)) reject('MANIFEST_INVALID');
    targetPaths.add(targetPath);
    requireDigestPair(target.input);
    requireDigestPair(target.output);
  }

  if (!Array.isArray(patch.patches)) reject('MANIFEST_INVALID');
  if (kind === 'unmodified' && patch.patches.length !== 0) reject('MANIFEST_INVALID');
  if (kind === 'patched' && patch.patches.length === 0) reject('MANIFEST_INVALID');

  const patchIds = new Set();
  const patchReferences = patch.patches.map((patchReference) => {
    const record = requireRecord(patchReference);
    requireExactKeys(record, [
      'id',
      'file',
      'openclawVersion',
      'sourceRevision',
      'input',
      'output',
      'executionRecord',
    ]);
    const id = requireIdentifier(record.id);
    if (patchIds.has(id)) reject('MANIFEST_INVALID');
    patchIds.add(id);
    if (requireVersion(record.openclawVersion) !== openclawVersion) {
      reject('VERSION_MISMATCH');
    }
    if (requireRevision(record.sourceRevision) !== sourceRevision) {
      reject('VERSION_MISMATCH');
    }
    const patchFile = validateFileReference(record.file, fileRegistry);
    const inputDigest = requireDigestPair(record.input);
    const outputDigest = requireDigestPair(record.output);
    const executionRecord = validateFileReference(record.executionRecord, fileRegistry);
    return { patchFile, inputDigest, outputDigest, executionRecord };
  });

  return { input, output, executionRecord, patchReferences };
}

function validateSourceReferences(value, openclawVersion, sourceRevision, fileRegistry) {
  if (!Array.isArray(value) || value.length === 0) reject('MANIFEST_INVALID');

  const sourceIds = new Set();
  const sourceKinds = new Set();
  const protocolPointers = new Set();
  const sourceReferences = value.map((sourceReference) => {
    const source = requireRecord(sourceReference);
    requireExactKeys(source, ['id', 'kind', 'file', 'openclawVersion', 'revision', 'protocol']);
    const id = requireIdentifier(source.id);
    const kind = requireString(source.kind, 'MANIFEST_INVALID', 32);
    if (!['handler', 'schema', 'error'].includes(kind)) reject('MANIFEST_INVALID');
    if (sourceIds.has(id)) reject('MANIFEST_INVALID');
    sourceIds.add(id);
    sourceKinds.add(kind);

    if (requireVersion(source.openclawVersion) !== openclawVersion) {
      reject('VERSION_MISMATCH');
    }
    if (requireRevision(source.revision) !== sourceRevision) reject('VERSION_MISMATCH');

    const protocol = requireRecord(source.protocol);
    requireExactKeys(protocol, ['kind', 'pointer']);
    const protocolKind = requireString(protocol.kind, 'MANIFEST_INVALID', 32);
    const pointer = requireString(protocol.pointer, 'MANIFEST_INVALID', 512);
    if (
      (kind === 'handler' && !['method', 'event'].includes(protocolKind)) ||
      (kind === 'schema' && protocolKind !== 'schema') ||
      (kind === 'error' && protocolKind !== 'error')
    ) {
      reject('MANIFEST_INVALID');
    }

    const protocolPointer = `${protocolKind}:${pointer}`;
    if (protocolPointers.has(protocolPointer)) reject('MANIFEST_INVALID');
    protocolPointers.add(protocolPointer);
    return {
      id,
      kind,
      protocolKind,
      pointer,
      ...validateFileReference(source.file, fileRegistry),
    };
  });

  for (const kind of ['handler', 'schema', 'error']) {
    if (!sourceKinds.has(kind)) reject('MANIFEST_INVALID');
  }
  return sourceReferences;
}

function validateFixtures(value, platformArchives, sourceReferences, fileRegistry) {
  if (!Array.isArray(value) || value.length === 0) reject('MANIFEST_INVALID');

  const sourceReferenceById = new Map(sourceReferences.map((source) => [source.id, source]));
  const archiveByPlatform = new Map(platformArchives.map((archive) => [archive.platform, archive]));
  const fixtureIds = new Set();
  const fixtureCoverage = new Map(
    platformArchives.flatMap((archive) =>
      sourceReferences.map((source) => [`${archive.platform}:${source.id}`, new Set()]),
    ),
  );

  const fixtures = value.map((fixtureReference) => {
    const fixture = requireRecord(fixtureReference);
    requireExactKeys(fixture, ['id', 'expectation', 'file', 'platform', 'archive', 'sourceRefs']);
    const id = requireIdentifier(fixture.id);
    if (fixtureIds.has(id)) reject('MANIFEST_INVALID');
    fixtureIds.add(id);

    const expectation = requireString(fixture.expectation, 'MANIFEST_INVALID', 16);
    if (!['positive', 'negative'].includes(expectation)) reject('MANIFEST_INVALID');
    const platform = requirePlatform(fixture.platform);
    const archive = archiveByPlatform.get(platform);
    if (!archive) reject('FIXTURE_MAPPING_INVALID');
    try {
      validateArchiveBinding(fixture.archive, archive.archive);
    } catch (error) {
      if (error instanceof EvidenceVerificationError && error.code === 'ARTIFACT_EVIDENCE_INVALID') {
        reject('FIXTURE_MAPPING_INVALID');
      }
      throw error;
    }
    if (!Array.isArray(fixture.sourceRefs) || fixture.sourceRefs.length === 0) {
      reject('FIXTURE_MAPPING_INVALID');
    }

    const mappedSourceIds = new Set();
    for (const sourceRef of fixture.sourceRefs) {
      const reference = requireRecord(sourceRef, 'FIXTURE_MAPPING_INVALID');
      requireExactKeys(reference, ['sourceId', 'kind', 'pointer']);
      const sourceId = requireIdentifier(reference.sourceId);
      const source = sourceReferenceById.get(sourceId);
      if (
        !source ||
        source.protocolKind !== requireString(reference.kind, 'FIXTURE_MAPPING_INVALID', 32) ||
        source.pointer !== requireString(reference.pointer, 'FIXTURE_MAPPING_INVALID', 512) ||
        mappedSourceIds.has(sourceId)
      ) {
        reject('FIXTURE_MAPPING_INVALID');
      }
      mappedSourceIds.add(sourceId);
      fixtureCoverage.get(`${platform}:${sourceId}`).add(expectation);
    }

    return { id, ...validateFileReference(fixture.file, fileRegistry) };
  });

  for (const expectationTypes of fixtureCoverage.values()) {
    if (!expectationTypes.has('positive') || !expectationTypes.has('negative')) {
      reject('FIXTURE_MAPPING_INVALID');
    }
  }
  return fixtures;
}

function validateManifest(value) {
  const manifest = requireRecord(value);
  requireExactKeys(manifest, [
    'formatVersion',
    'bundleId',
    'bundleVersion',
    'platformArchives',
    'openclaw',
    'fixtures',
  ]);
  if (manifest.formatVersion !== MANIFEST_FORMAT_VERSION) reject('MANIFEST_INVALID');

  const bundleId = requireIdentifier(manifest.bundleId);
  const bundleVersion = requireVersion(manifest.bundleVersion);
  const openclaw = requireRecord(manifest.openclaw);
  requireExactKeys(openclaw, [
    'version',
    'sourceRevision',
    'sourceArchive',
    'packageManifest',
    'lockfile',
    'patch',
    'sourceReferences',
  ]);
  const openclawVersion = requireVersion(openclaw.version);
  const sourceRevision = requireRevision(openclaw.sourceRevision);
  const fileRegistry = createFileReferenceRegistry();
  const sourceArchive = validateFileReference(openclaw.sourceArchive, fileRegistry);
  const packageManifest = validateFileReference(openclaw.packageManifest, fileRegistry);
  const lockfile = validateFileReference(openclaw.lockfile, fileRegistry);
  if (!Array.isArray(manifest.platformArchives) || manifest.platformArchives.length === 0) {
    reject('MANIFEST_INVALID');
  }

  const platforms = new Set();
  const platformArchives = manifest.platformArchives.map((archiveEntry) => {
    const archiveRecord = requireRecord(archiveEntry);
    const platform = requirePlatform(archiveRecord.platform);
    if (platforms.has(platform)) reject('MANIFEST_INVALID');
    platforms.add(platform);
    return validatePlatformArchive(
      archiveRecord,
      openclawVersion,
      sourceRevision,
      sourceArchive,
      lockfile,
      fileRegistry,
    );
  });
  const patch = validatePatch(openclaw.patch, openclawVersion, sourceRevision, fileRegistry);
  const sourceReferences = validateSourceReferences(
    openclaw.sourceReferences,
    openclawVersion,
    sourceRevision,
    fileRegistry,
  );
  const fixtures = validateFixtures(
    manifest.fixtures,
    platformArchives,
    sourceReferences,
    fileRegistry,
  );

  return {
    bundleId,
    bundleVersion,
    openclawVersion,
    platformArchives,
    sourceArchive,
    packageManifest,
    lockfile,
    patch,
    sourceReferences,
    fixtures,
  };
}

function sameFileIdentity(left, right) {
  return left.dev === right.dev && left.ino === right.ino;
}

function isContainedPath(root, candidate) {
  const relative = path.relative(root, candidate);
  return !(
    relative === '' ||
    relative === '..' ||
    relative.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relative)
  );
}

function fileIdentity(stat) {
  if (
    (typeof stat.dev !== 'number' && typeof stat.dev !== 'bigint') ||
    (typeof stat.ino !== 'number' && typeof stat.ino !== 'bigint')
  ) {
    reject('BUNDLE_UNREADABLE');
  }
  return `${stat.dev}:${stat.ino}`;
}

async function openBundleRoot(bundleDirectory) {
  let root;
  let identity;
  try {
    root = await fs.realpath(bundleDirectory);
    const stat = await fs.stat(root, { bigint: true });
    if (!stat.isDirectory()) reject('BUNDLE_UNREADABLE');
    identity = fileIdentity(stat);
  } catch (error) {
    if (error instanceof EvidenceVerificationError) throw error;
    reject('BUNDLE_UNREADABLE');
  }
  return { root, identity, physicalFiles: new Map() };
}

async function assertBundleRoot(bundle) {
  let stat;
  let resolved;
  try {
    resolved = await fs.realpath(bundle.root);
    stat = await fs.stat(resolved, { bigint: true });
  } catch {
    reject('BUNDLE_UNREADABLE');
  }
  if (!stat.isDirectory() || fileIdentity(stat) !== bundle.identity) {
    reject('BUNDLE_UNREADABLE');
  }
}

async function inspectContainedFile(bundle, relativePath) {
  const normalizedRelativePath = requireRelativePath(relativePath);
  await assertBundleRoot(bundle);

  let candidate = bundle.root;
  const segments = normalizedRelativePath.split('/');
  for (const [index, segment] of segments.entries()) {
    candidate = path.join(candidate, segment);
    let stat;
    try {
      stat = await fs.lstat(candidate);
    } catch {
      reject('BUNDLE_UNREADABLE');
    }
    if (stat.isSymbolicLink()) reject('PATH_OUTSIDE_BUNDLE');
    if (index < segments.length - 1 && !stat.isDirectory()) reject('BUNDLE_UNREADABLE');
    if (index === segments.length - 1 && !stat.isFile()) reject('BUNDLE_UNREADABLE');
  }

  let resolved;
  try {
    resolved = await fs.realpath(candidate);
  } catch {
    reject('BUNDLE_UNREADABLE');
  }
  if (!isContainedPath(bundle.root, resolved)) reject('PATH_OUTSIDE_BUNDLE');

  let stat;
  try {
    stat = await fs.lstat(candidate, { bigint: true });
  } catch {
    reject('BUNDLE_UNREADABLE');
  }
  if (stat.isSymbolicLink() || !stat.isFile()) reject('BUNDLE_UNREADABLE');
  return { candidate, stat };
}

async function closeQuietly(handle) {
  try {
    await handle?.close();
  } catch {
    // The verifier is already rejecting the bundle on this path.
  }
}

async function openContainedFile(bundle, relativePath) {
  const inspected = await inspectContainedFile(bundle, relativePath);
  let handle;
  try {
    handle = await fs.open(inspected.candidate, 'r');
    const openedStat = await handle.stat({ bigint: true });
    if (!openedStat.isFile() || !sameFileIdentity(inspected.stat, openedStat)) {
      reject('BUNDLE_UNREADABLE');
    }
    await assertBundleRoot(bundle);
    const current = await inspectContainedFile(bundle, relativePath);
    if (!sameFileIdentity(openedStat, current.stat)) reject('BUNDLE_UNREADABLE');
    return { handle, identity: fileIdentity(openedStat) };
  } catch (error) {
    await closeQuietly(handle);
    if (error instanceof EvidenceVerificationError) throw error;
    reject('BUNDLE_UNREADABLE');
  }
}

async function hashOpenedFile(handle) {
  const initialStat = await handle.stat({ bigint: true });
  if (!initialStat.isFile()) reject('BUNDLE_UNREADABLE');

  const sha256 = crypto.createHash('sha256');
  const sha512 = crypto.createHash('sha512');
  const buffer = Buffer.allocUnsafe(64 * 1024);
  let position = 0;
  while (true) {
    let bytesRead;
    try {
      ({ bytesRead } = await handle.read(buffer, 0, buffer.length, position));
    } catch {
      reject('BUNDLE_UNREADABLE');
    }
    if (bytesRead === 0) break;
    const chunk = buffer.subarray(0, bytesRead);
    sha256.update(chunk);
    sha512.update(chunk);
    position += bytesRead;
  }
  const finalStat = await handle.stat({ bigint: true });
  if (!sameFileIdentity(initialStat, finalStat) || finalStat.size !== BigInt(position)) {
    reject('BUNDLE_UNREADABLE');
  }
  return { sha256: sha256.digest('hex'), sha512: sha512.digest('hex') };
}

async function readOpenedTextAndHash(handle, maximumBytes) {
  const initialStat = await handle.stat({ bigint: true });
  if (!initialStat.isFile() || initialStat.size > maximumBytes) reject('MANIFEST_INVALID');

  const chunks = [];
  const sha256 = crypto.createHash('sha256');
  const sha512 = crypto.createHash('sha512');
  const buffer = Buffer.allocUnsafe(64 * 1024);
  let position = 0;
  while (true) {
    let bytesRead;
    try {
      ({ bytesRead } = await handle.read(buffer, 0, buffer.length, position));
    } catch {
      reject('BUNDLE_UNREADABLE');
    }
    if (bytesRead === 0) break;
    position += bytesRead;
    if (position > maximumBytes) reject('MANIFEST_INVALID');
    const chunk = Buffer.from(buffer.subarray(0, bytesRead));
    chunks.push(chunk);
    sha256.update(chunk);
    sha512.update(chunk);
  }
  const finalStat = await handle.stat({ bigint: true });
  if (!sameFileIdentity(initialStat, finalStat) || finalStat.size !== BigInt(position)) {
    reject('BUNDLE_UNREADABLE');
  }
  return {
    text: Buffer.concat(chunks).toString('utf8'),
    hashes: { sha256: sha256.digest('hex'), sha512: sha512.digest('hex') },
  };
}

function registerPhysicalFile(bundle, logicalPath, identity) {
  const existingPath = bundle.physicalFiles.get(identity);
  if (existingPath && existingPath !== logicalPath) reject('MANIFEST_INVALID');
  bundle.physicalFiles.set(identity, logicalPath);
}

async function readContainedText(bundle, relativePath, maximumBytes) {
  const opened = await openContainedFile(bundle, relativePath);
  try {
    const result = await readOpenedTextAndHash(opened.handle, maximumBytes);
    registerPhysicalFile(bundle, relativePath, opened.identity);
    return result;
  } finally {
    await closeQuietly(opened.handle);
  }
}

async function assertNoUnreferencedBundleFiles(bundle, verifiedFiles) {
  const expectedFiles = new Set([MANIFEST_FILE_NAME, SIGNATURE_FILE_NAME, ...verifiedFiles.keys()]);
  const entries = await fs.readdir(bundle.root, { recursive: true, withFileTypes: true });
  for (const entry of entries) {
    if (entry.isSymbolicLink()) reject('PATH_OUTSIDE_BUNDLE');
    if (!entry.isFile()) continue;
    const relativePath = path
      .relative(bundle.root, path.resolve(entry.parentPath, entry.name))
      .split(path.sep)
      .join('/');
    if (!expectedFiles.has(requireRelativePath(relativePath))) reject('MANIFEST_INVALID');
  }
}

async function verifyReferencedHash(bundle, reference, verifiedFiles) {
  const existing = verifiedFiles.get(reference.path);
  if (existing) {
    if (existing.sha256 !== reference.sha256 || existing.sha512 !== reference.sha512) {
      reject('MANIFEST_INVALID');
    }
    return undefined;
  }

  const opened = await openContainedFile(bundle, reference.path);
  try {
    const actualHashes = await hashOpenedFile(opened.handle);
    if (
      actualHashes.sha256 !== reference.sha256 ||
      actualHashes.sha512 !== reference.sha512
    ) {
      reject('HASH_MISMATCH');
    }
    registerPhysicalFile(bundle, reference.path, opened.identity);
    verifiedFiles.set(reference.path, {
      sha256: reference.sha256,
      sha512: reference.sha512,
    });
    return undefined;
  } finally {
    await closeQuietly(opened.handle);
  }
}

async function readVerifiedReferenceText(bundle, reference, verifiedFiles, maximumBytes) {
  if (verifiedFiles.has(reference.path)) reject('MANIFEST_INVALID');
  const opened = await openContainedFile(bundle, reference.path);
  try {
    const result = await readOpenedTextAndHash(opened.handle, maximumBytes);
    if (
      result.hashes.sha256 !== reference.sha256 ||
      result.hashes.sha512 !== reference.sha512
    ) {
      reject('HASH_MISMATCH');
    }
    registerPhysicalFile(bundle, reference.path, opened.identity);
    verifiedFiles.set(reference.path, {
      sha256: reference.sha256,
      sha512: reference.sha512,
    });
    return result.text;
  } finally {
    await closeQuietly(opened.handle);
  }
}

function decodeBase64Signature(signatureSource, code) {
  const encoded = requireString(signatureSource, code, 16 * 1024);
  if (encoded !== encoded.trim() || !BASE64_PATTERN.test(encoded)) reject(code);

  const signature = Buffer.from(encoded, 'base64');
  if (signature.length === 0 || signature.toString('base64') !== encoded) reject(code);
  return signature;
}

function verifyDetachedSignature(source, signatureSource, trustedPublicKeyPem, code = 'SIGNATURE_INVALID') {
  const trustedKey = requireString(trustedPublicKeyPem, 'TRUST_KEY_INVALID');
  const signature = decodeBase64Signature(signatureSource, code);

  try {
    if (!crypto.verify(null, Buffer.from(source), trustedKey, signature)) {
      reject(code);
    }
  } catch (error) {
    if (error instanceof EvidenceVerificationError) throw error;
    reject(code);
  }
}

export async function verifyHistoricalOpenClawEvidenceBundle(options) {
  const bundleDirectory = requireString(options?.bundleDirectory, 'BUNDLE_UNREADABLE');
  const bundle = await openBundleRoot(bundleDirectory);

  const manifest = await readContainedText(bundle, MANIFEST_FILE_NAME, 1024 * 1024);
  const signature = await readContainedText(bundle, SIGNATURE_FILE_NAME, 16 * 1024);
  verifyDetachedSignature(manifest.text, signature.text, options.trustedPublicKeyPem);

  let verifiedManifestSource;
  try {
    verifiedManifestSource = JSON.parse(manifest.text);
  } catch {
    reject('MANIFEST_INVALID');
  }

  const verifiedManifest = validateManifest(verifiedManifestSource);
  const verifiedFiles = new Map();
  const packageManifestSource = await readVerifiedReferenceText(
    bundle,
    verifiedManifest.packageManifest,
    verifiedFiles,
    1024 * 1024,
  );
  let packageManifest;
  try {
    packageManifest = JSON.parse(packageManifestSource);
  } catch {
    reject('MANIFEST_INVALID');
  }
  if (
    !isRecord(packageManifest) ||
    packageManifest.name !== 'openclaw' ||
    packageManifest.version !== verifiedManifest.openclawVersion
  ) {
    reject('VERSION_MISMATCH');
  }

  await verifyReferencedHash(bundle, verifiedManifest.sourceArchive, verifiedFiles);
  await verifyReferencedHash(bundle, verifiedManifest.lockfile, verifiedFiles);
  await verifyReferencedHash(bundle, verifiedManifest.patch.input, verifiedFiles);
  await verifyReferencedHash(bundle, verifiedManifest.patch.output, verifiedFiles);
  await verifyReferencedHash(bundle, verifiedManifest.patch.executionRecord, verifiedFiles);
  for (const patchReference of verifiedManifest.patch.patchReferences) {
    await verifyReferencedHash(bundle, patchReference.patchFile, verifiedFiles);
    await verifyReferencedHash(bundle, patchReference.executionRecord, verifiedFiles);
  }
  for (const archive of verifiedManifest.platformArchives) {
    await verifyReferencedHash(bundle, archive.archive, verifiedFiles);
    for (const payload of archive.payloads) {
      await verifyReferencedHash(bundle, payload, verifiedFiles);
    }
    await verifyReferencedHash(bundle, archive.buildProvenance.record, verifiedFiles);
    const artifactSignatureSource = await readVerifiedReferenceText(
      bundle,
      archive.artifactSignature,
      verifiedFiles,
      16 * 1024,
    );
    verifyDetachedSignature(
      Buffer.from(archive.archive.sha256, 'hex'),
      artifactSignatureSource,
      options.trustedArtifactPublicKeyPem,
      'ARTIFACT_SIGNATURE_INVALID',
    );
    // Platform trust roots are external to this verifier; these records prove
    // immutable delivery and archive binding, not platform signature validity.
    for (const evidenceRecord of archive.externalEvidence) {
      await verifyReferencedHash(bundle, evidenceRecord, verifiedFiles);
    }
    await verifyReferencedHash(bundle, archive.buildProvenance.buildParameters, verifiedFiles);
  }
  for (const sourceReference of verifiedManifest.sourceReferences) {
    await verifyReferencedHash(bundle, sourceReference, verifiedFiles);
  }
  for (const fixture of verifiedManifest.fixtures) {
    await verifyReferencedHash(bundle, fixture, verifiedFiles);
  }
  await assertNoUnreferencedBundleFiles(bundle, verifiedFiles);

  return {
    receiptVersion: RECEIPT_VERSION,
    status: 'verified',
    bundleId: verifiedManifest.bundleId,
    bundleVersion: verifiedManifest.bundleVersion,
    archives: verifiedManifest.platformArchives.map((archive) => ({
      platform: archive.platform,
      openclawVersion: archive.openclawVersion,
      sha256: archive.archive.sha256,
      signature: {
        algorithm: archive.artifactSignature.algorithm,
        keyId: archive.artifactSignature.keyId,
      },
    })),
    verified: {
      fileCount: verifiedFiles.size,
      platformArchiveCount: verifiedManifest.platformArchives.length,
      sourceReferenceCount: verifiedManifest.sourceReferences.length,
      fixtureCount: verifiedManifest.fixtures.length,
    },
  };
}

async function importVerifiedBundle(options, destinationDirectory) {
  if (!path.isAbsolute(destinationDirectory)) reject('IMPORT_DESTINATION_INVALID');
  await verifyHistoricalOpenClawEvidenceBundle(options);
  const source = await openBundleRoot(options.bundleDirectory);
  let staging;
  try {
    const destination = path.resolve(destinationDirectory);
    const parent = path.dirname(destination);
    if (destination === source.root || isContainedPath(source.root, destination)) {
      reject('IMPORT_DESTINATION_INVALID');
    }
    const parentStat = await fs.lstat(parent);
    if (!parentStat.isDirectory() || parentStat.isSymbolicLink()) reject('IMPORT_DESTINATION_INVALID');
    if (await fs.lstat(destination).then(() => true, () => false)) {
      reject('IMPORT_DESTINATION_EXISTS');
    }

    staging = path.join(parent, `${IMPORT_STAGING_PREFIX}${crypto.randomUUID()}`);
    await fs.cp(source.root, staging, {
      recursive: true,
      dereference: false,
      errorOnExist: true,
      force: false,
    });
    const receipt = await verifyHistoricalOpenClawEvidenceBundle({
      bundleDirectory: staging,
      trustedPublicKeyPem: options.trustedPublicKeyPem,
      trustedArtifactPublicKeyPem: options.trustedArtifactPublicKeyPem,
    });
    if (await fs.lstat(destination).then(() => true, () => false)) {
      reject('IMPORT_DESTINATION_EXISTS');
    }
    await fs.rename(staging, destination);
    staging = undefined;
    return receipt;
  } catch (error) {
    if (staging) await fs.rm(staging, { recursive: true, force: true }).catch(() => undefined);
    if (error instanceof EvidenceVerificationError) throw error;
    reject('IMPORT_FAILED');
  }
}

export async function importHistoricalOpenClawEvidenceBundle(options) {
  const destinationDirectory = requireString(
    options?.destinationDirectory,
    'IMPORT_DESTINATION_INVALID',
    4096,
  );
  const receipt = await importVerifiedBundle(options, destinationDirectory);
  return { ...receipt, import: { status: 'imported' } };
}

function parseCliArguments(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (
      argument !== '--bundle' &&
      argument !== '--trusted-public-key' &&
      argument !== '--trusted-artifact-public-key' &&
      argument !== '--import-to'
    ) {
      reject('CLI_ARGUMENT_INVALID');
    }
    const value = argv[index + 1];
    if (!value || value.startsWith('--') || options[argument]) reject('CLI_ARGUMENT_INVALID');
    options[argument] = value;
    index += 1;
  }
  if (!options['--bundle'] || !options['--trusted-public-key'] || !options['--trusted-artifact-public-key']) {
    reject('CLI_ARGUMENT_INVALID');
  }
  return options;
}

async function runCli() {
  try {
    const cliOptions = parseCliArguments(process.argv.slice(2));
    const trustedPublicKeyPem = await fs.readFile(cliOptions['--trusted-public-key'], 'utf8');
    const trustedArtifactPublicKeyPem = await fs.readFile(cliOptions['--trusted-artifact-public-key'], 'utf8');
    const verificationOptions = {
      bundleDirectory: cliOptions['--bundle'],
      trustedPublicKeyPem,
      trustedArtifactPublicKeyPem,
    };
    const receipt = cliOptions['--import-to']
      ? await importHistoricalOpenClawEvidenceBundle({
          ...verificationOptions,
          destinationDirectory: cliOptions['--import-to'],
        })
      : await verifyHistoricalOpenClawEvidenceBundle(verificationOptions);
    process.stdout.write(`${JSON.stringify(receipt)}\n`);
  } catch (error) {
    const code = error instanceof EvidenceVerificationError ? error.code : 'BUNDLE_UNREADABLE';
    process.stdout.write(`${JSON.stringify({ receiptVersion: RECEIPT_VERSION, status: 'rejected', code })}\n`);
    process.exitCode = 1;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await runCli();
}
