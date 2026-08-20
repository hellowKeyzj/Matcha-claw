import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import {
  importHistoricalOpenClawEvidenceBundle,
  verifyHistoricalOpenClawEvidenceBundle,
} from '../../scripts/verify-historical-openclaw-evidence.mjs';

const temporaryRoots: string[] = [];
const OPENCLAW_VERSION = '2025.1.1';
const SOURCE_REVISION = '0123456789abcdef0123456789abcdef01234567';
const VERIFIER_SCRIPT = path.resolve(__dirname, '../../scripts/verify-historical-openclaw-evidence.mjs');

interface FileReference {
  path: string;
  sha256: string;
  sha512: string;
}

interface EvidenceBundleFixture {
  root: string;
  trustedPublicKeyPem: string;
  trustedArtifactPublicKeyPem: string;
  manifest: Record<string, any>;
  writeSignedManifest: () => void;
}

function hashFileContent(content: string | Buffer): Pick<FileReference, 'sha256' | 'sha512'> {
  return {
    sha256: crypto.createHash('sha256').update(content).digest('hex'),
    sha512: crypto.createHash('sha512').update(content).digest('hex'),
  };
}

function writeBundleFile(root: string, relativePath: string, content: string | Buffer): FileReference {
  const filePath = path.join(root, relativePath);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content);
  return { path: relativePath, ...hashFileContent(content) };
}

function archiveBinding(file: FileReference) {
  return { sha256: file.sha256, sha512: file.sha512 };
}

function createTestOnlyEvidenceBundle(): EvidenceBundleFixture {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'matcha-evidence-verifier-test-'));
  temporaryRoots.push(root);

  const sourceArchive = writeBundleFile(root, 'sources/openclaw-source.tar.gz', 'test source archive');
  const packageManifest = writeBundleFile(
    root,
    'sources/openclaw-package.json',
    `${JSON.stringify({ name: 'openclaw', version: OPENCLAW_VERSION })}\n`,
  );
  const lockfile = writeBundleFile(root, 'sources/pnpm-lock.yaml', 'lockfileVersion: 9\n');
  const patchInput = writeBundleFile(root, 'patch/input-digests.json', 'test patch input digests');
  const patchOutput = writeBundleFile(root, 'patch/output-digests.json', 'test patch output digests');
  const patchExecutionRecord = writeBundleFile(
    root,
    'patch/execution-record.json',
    'test patch execution record',
  );

  const sourceReferences = [
    {
      id: 'gateway-status-handler',
      kind: 'handler',
      file: writeBundleFile(root, 'protocol/status-handler.ts', 'test status handler'),
      openclawVersion: OPENCLAW_VERSION,
      revision: SOURCE_REVISION,
      protocol: { kind: 'method', pointer: 'status' },
    },
    {
      id: 'gateway-chat-event-handler',
      kind: 'handler',
      file: writeBundleFile(root, 'protocol/chat-event-handler.ts', 'test chat event handler'),
      openclawVersion: OPENCLAW_VERSION,
      revision: SOURCE_REVISION,
      protocol: { kind: 'event', pointer: 'chat' },
    },
    {
      id: 'gateway-status-schema',
      kind: 'schema',
      file: writeBundleFile(root, 'protocol/status-schema.ts', 'test status schema'),
      openclawVersion: OPENCLAW_VERSION,
      revision: SOURCE_REVISION,
      protocol: { kind: 'schema', pointer: 'GatewayStatus' },
    },
    {
      id: 'gateway-error-schema',
      kind: 'error',
      file: writeBundleFile(root, 'protocol/errors.ts', 'test gateway error'),
      openclawVersion: OPENCLAW_VERSION,
      revision: SOURCE_REVISION,
      protocol: { kind: 'error', pointer: 'GatewayUnavailable' },
    },
  ];

  const { privateKey: artifactPrivateKey, publicKey: artifactPublicKey } = crypto.generateKeyPairSync('ed25519');
  const trustedArtifactPublicKeyPem = artifactPublicKey.export({ type: 'spki', format: 'pem' }).toString();
  const platforms = ['win32-x64', 'darwin-arm64', 'linux-x64'];
  const platformArchives = platforms.map((platform) => {
    const archive = writeBundleFile(root, `artifacts/${platform}/installer.bin`, `test ${platform} archive`);
    const artifactSignature = writeBundleFile(
      root,
      `artifacts/${platform}/installer.sig`,
      crypto.sign(null, Buffer.from(archive.sha256, 'hex'), artifactPrivateKey).toString('base64'),
    );
    const packagePayload = writeBundleFile(
      root,
      `payloads/${platform}/openclaw.tgz`,
      `test ${platform} OpenClaw payload`,
    );
    const platformEvidenceFiles: Partial<Record<'certificate' | 'codesign' | 'notarization', FileReference>> = platform.startsWith('darwin-')
      ? {
          certificate: writeBundleFile(root, `evidence/${platform}/certificate.json`, 'test certificate record'),
          codesign: writeBundleFile(root, `evidence/${platform}/codesign.json`, 'test codesign record'),
          notarization: writeBundleFile(root, `evidence/${platform}/notarization.json`, 'test notarization record'),
        }
      : platform.startsWith('win32-')
        ? {
            certificate: writeBundleFile(root, `evidence/${platform}/certificate.json`, 'test certificate record'),
            codesign: writeBundleFile(root, `evidence/${platform}/codesign.json`, 'test codesign record'),
          }
        : {};
    const provenanceRecord = writeBundleFile(root, `provenance/${platform}/record.json`, 'test provenance record');
    const buildParameters = writeBundleFile(root, `provenance/${platform}/parameters.json`, 'test build parameters');

    return {
      platform,
      openclawVersion: OPENCLAW_VERSION,
      archive,
      payloads: [
        {
          id: `${platform}-openclaw-package`,
          kind: 'openclaw-package',
          file: packagePayload,
          openclawVersion: OPENCLAW_VERSION,
          archive: archiveBinding(archive),
        },
      ],
      immutableLocator: {
        kind: 'release',
        id: `release-${platform}`,
        uri: `https://archive.example.test/releases/${platform}`,
        version: '1.0.0',
        openclawVersion: OPENCLAW_VERSION,
        archive: archiveBinding(archive),
      },
      evidence: {
        artifactSignature: {
          algorithm: 'ed25519',
          keyId: 'test-artifact-signer',
          version: OPENCLAW_VERSION,
          file: artifactSignature,
          archive: archiveBinding(archive),
        },
        ...(platform.startsWith('darwin-')
          ? {
              certificate: {
                format: 'x509-chain',
                version: OPENCLAW_VERSION,
                record: platformEvidenceFiles.certificate,
                archive: archiveBinding(archive),
              },
              codesign: {
                format: 'apple-codesign',
                version: OPENCLAW_VERSION,
                record: platformEvidenceFiles.codesign,
                archive: archiveBinding(archive),
              },
              notarization: {
                format: 'apple-notarization',
                version: OPENCLAW_VERSION,
                record: platformEvidenceFiles.notarization,
                archive: archiveBinding(archive),
              },
            }
          : platform.startsWith('win32-')
            ? {
                certificate: {
                  format: 'x509-chain',
                  version: OPENCLAW_VERSION,
                  record: platformEvidenceFiles.certificate,
                  archive: archiveBinding(archive),
                },
                authenticode: {
                  format: 'authenticode',
                  version: OPENCLAW_VERSION,
                  record: platformEvidenceFiles.codesign,
                  archive: archiveBinding(archive),
                },
              }
            : {}),
      },
      buildProvenance: {
        format: 'in-toto',
        version: OPENCLAW_VERSION,
        record: provenanceRecord,
        sourceRevision: SOURCE_REVISION,
        sourceArchive: archiveBinding(sourceArchive),
        dependencyLock: archiveBinding(lockfile),
        dependencyDigest: archiveBinding(lockfile),
        buildRun: {
          provider: 'test-ci',
          workflow: 'release.yml',
          runId: `run-${platform}`,
          attempt: 1,
          uri: `https://ci.example.test/runs/${platform}`,
        },
        buildParameters,
        target: { platform },
        startedAt: '2025-01-01T00:00:00.000Z',
        completedAt: '2025-01-01T00:01:00.000Z',
        archive: archiveBinding(archive),
      },
    };
  });

  const fixtures = platformArchives.flatMap((archive) =>
    sourceReferences.flatMap((source) =>
      (['positive', 'negative'] as const).map((expectation) => ({
        id: `${archive.platform}-${source.id}-${expectation}`,
        expectation,
        file: writeBundleFile(
          root,
          `fixtures/${archive.platform}/${source.id}-${expectation}.json`,
          `test ${expectation} fixture for ${source.protocol.kind}:${source.protocol.pointer}`,
        ),
        platform: archive.platform,
        archive: archiveBinding(archive.archive),
        sourceRefs: [
          {
            sourceId: source.id,
            kind: source.protocol.kind,
            pointer: source.protocol.pointer,
          },
        ],
      })),
    ),
  );

  const manifest: Record<string, any> = {
    formatVersion: 2,
    bundleId: 'test-openclaw-evidence-bundle',
    bundleVersion: '1.0.0',
    platformArchives,
    openclaw: {
      version: OPENCLAW_VERSION,
      sourceRevision: SOURCE_REVISION,
      sourceArchive,
      packageManifest,
      lockfile,
      patch: {
        kind: 'unmodified',
        version: OPENCLAW_VERSION,
        sourceRevision: SOURCE_REVISION,
        input: patchInput,
        output: patchOutput,
        executionRecord: patchExecutionRecord,
        targetFiles: [
          {
            path: 'packages/openclaw/package.json',
            input: archiveBinding(packageManifest),
            output: archiveBinding(packageManifest),
          },
        ],
        patches: [],
      },
      sourceReferences,
    },
    fixtures,
  };

  const { privateKey, publicKey } = crypto.generateKeyPairSync('ed25519');
  const trustedPublicKeyPem = publicKey.export({ type: 'spki', format: 'pem' }).toString();
  const privateKeyPem = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
  const writeSignedManifest = () => {
    const manifestSource = `${JSON.stringify(manifest, null, 2)}\n`;
    const signature = crypto.sign(null, Buffer.from(manifestSource), privateKeyPem);
    fs.writeFileSync(path.join(root, 'manifest.json'), manifestSource);
    fs.writeFileSync(path.join(root, 'manifest.sig'), signature.toString('base64'));
  };

  writeSignedManifest();
  return {
    root,
    trustedPublicKeyPem,
    trustedArtifactPublicKeyPem,
    manifest,
    writeSignedManifest,
  };
}

async function expectVerificationFailure(
  bundle: EvidenceBundleFixture,
  code: string,
): Promise<void> {
  let thrown: unknown;
  try {
    await verifyHistoricalOpenClawEvidenceBundle({
      bundleDirectory: bundle.root,
      trustedPublicKeyPem: bundle.trustedPublicKeyPem,
      trustedArtifactPublicKeyPem: bundle.trustedArtifactPublicKeyPem,
    });
  } catch (error) {
    thrown = error;
  }

  expect(thrown).toMatchObject({ code });
}

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

describe('verifyHistoricalOpenClawEvidenceBundle', () => {
  it('verifies a fully mapped, platform-specific v2 test contract without exposing bundle paths', async () => {
    const bundle = createTestOnlyEvidenceBundle();

    const receipt = await verifyHistoricalOpenClawEvidenceBundle({
      bundleDirectory: bundle.root,
      trustedPublicKeyPem: bundle.trustedPublicKeyPem,
      trustedArtifactPublicKeyPem: bundle.trustedArtifactPublicKeyPem,
    });

    expect(receipt).toMatchObject({
      receiptVersion: 1,
      status: 'verified',
      bundleId: 'test-openclaw-evidence-bundle',
      bundleVersion: '1.0.0',
      archives: [
        { platform: 'win32-x64', openclawVersion: OPENCLAW_VERSION },
        { platform: 'darwin-arm64', openclawVersion: OPENCLAW_VERSION },
        { platform: 'linux-x64', openclawVersion: OPENCLAW_VERSION },
      ],
      verified: {
        platformArchiveCount: 3,
        sourceReferenceCount: 4,
        fixtureCount: 24,
      },
    });
    expect(JSON.stringify(receipt)).not.toContain(bundle.root);
    expect(JSON.stringify(receipt)).not.toContain('archive.example.test');
  });

  it('fails closed when the bundle contains an unreferenced file', async () => {
    const bundle = createTestOnlyEvidenceBundle();
    writeBundleFile(bundle.root, 'unreferenced/extra.txt', 'must not be silently imported');

    await expectVerificationFailure(bundle, 'MANIFEST_INVALID');
  });

  it.each([
    [
      'SHA-512',
      (manifest: Record<string, any>) => delete manifest.platformArchives[0].archive.sha512,
    ],
    [
      'patch execution record',
      (manifest: Record<string, any>) => delete manifest.openclaw.patch.executionRecord,
    ],
    [
      'unknown evidence field',
      (manifest: Record<string, any>) => (manifest.platformArchives[0].evidence.extra = true),
    ],
  ])('fails closed when the v2 manifest omits or adds %s', async (_label, mutate) => {
    const bundle = createTestOnlyEvidenceBundle();
    mutate(bundle.manifest);
    bundle.writeSignedManifest();

    await expectVerificationFailure(bundle, 'MANIFEST_INVALID');
  });

  it('fails closed when the artifact payload matrix reuses an archive path', async () => {
    const bundle = createTestOnlyEvidenceBundle();
    const archive = bundle.manifest.platformArchives[0].archive;
    bundle.manifest.platformArchives[0].payloads[0].file = archive;
    bundle.writeSignedManifest();

    await expectVerificationFailure(bundle, 'MANIFEST_INVALID');
  });

  it('fails closed when the platform archive matrix has a duplicate platform', async () => {
    const bundle = createTestOnlyEvidenceBundle();
    bundle.manifest.platformArchives[1].platform = bundle.manifest.platformArchives[0].platform;
    bundle.writeSignedManifest();

    await expectVerificationFailure(bundle, 'MANIFEST_INVALID');
  });

  it('fails closed when the platform matrix names an unsupported target', async () => {
    const bundle = createTestOnlyEvidenceBundle();
    bundle.manifest.platformArchives[0].platform = 'freebsd-x64';
    bundle.writeSignedManifest();

    await expectVerificationFailure(bundle, 'MANIFEST_INVALID');
  });

  it('fails closed when a platform payload is not bound to its archive', async () => {
    const bundle = createTestOnlyEvidenceBundle();
    bundle.manifest.platformArchives[0].payloads[0].archive.sha256 = '0'.repeat(64);
    bundle.writeSignedManifest();

    await expectVerificationFailure(bundle, 'ARTIFACT_EVIDENCE_INVALID');
  });

  it('fails closed when protocol source identifiers are duplicated', async () => {
    const bundle = createTestOnlyEvidenceBundle();
    bundle.manifest.openclaw.sourceReferences[1].id = bundle.manifest.openclaw.sourceReferences[0].id;
    bundle.writeSignedManifest();

    await expectVerificationFailure(bundle, 'MANIFEST_INVALID');
  });

  it.each(['sha256', 'sha512'] as const)(
    'fails closed when an archive %s declaration does not match',
    async (hashName) => {
      const bundle = createTestOnlyEvidenceBundle();
      // Tamper the declaration and every archive binding consistently so the
      // manifest stays internally coherent and rejection can only come from
      // comparing the declared hash against the actual archive bytes.
      const archiveEntry = bundle.manifest.platformArchives[0];
      const tampered = '0'.repeat(hashName === 'sha256' ? 64 : 128);
      const bindings = [
        archiveEntry.archive,
        archiveEntry.payloads[0].archive,
        archiveEntry.immutableLocator.archive,
        archiveEntry.evidence.artifactSignature.archive,
        archiveEntry.evidence.certificate.archive,
        archiveEntry.evidence.authenticode.archive,
        archiveEntry.buildProvenance.archive,
        ...bundle.manifest.fixtures
          .filter((fixture: { platform: string }) => fixture.platform === archiveEntry.platform)
          .map((fixture: { archive: Record<string, string> }) => fixture.archive),
      ];
      for (const binding of bindings) binding[hashName] = tampered;
      bundle.writeSignedManifest();

      await expectVerificationFailure(bundle, 'HASH_MISMATCH');
    },
  );

  it('fails closed when the Windows Authenticode record is not version-bound', async () => {
    const bundle = createTestOnlyEvidenceBundle();
    bundle.manifest.platformArchives[0].evidence.authenticode.version = '2025.1.2';
    bundle.writeSignedManifest();

    await expectVerificationFailure(bundle, 'VERSION_MISMATCH');
  });

  it('fails closed when macOS notarization evidence is missing', async () => {
    const bundle = createTestOnlyEvidenceBundle();
    delete bundle.manifest.platformArchives[1].evidence.notarization;
    bundle.writeSignedManifest();

    await expectVerificationFailure(bundle, 'MANIFEST_INVALID');
  });

  it('fails closed when the macOS codesign format is not Apple codesign', async () => {
    const bundle = createTestOnlyEvidenceBundle();
    bundle.manifest.platformArchives[1].evidence.codesign.format = 'authenticode';
    bundle.writeSignedManifest();

    await expectVerificationFailure(bundle, 'MANIFEST_INVALID');
  });

  it('fails closed when the Windows Authenticode format is not exact', async () => {
    const bundle = createTestOnlyEvidenceBundle();
    bundle.manifest.platformArchives[0].evidence.authenticode.format = 'apple-codesign';
    bundle.writeSignedManifest();

    await expectVerificationFailure(bundle, 'MANIFEST_INVALID');
  });

  it('fails closed when a Windows archive uses the Apple codesign field', async () => {
    const bundle = createTestOnlyEvidenceBundle();
    const evidence = bundle.manifest.platformArchives[0].evidence;
    evidence.codesign = evidence.authenticode;
    delete evidence.authenticode;
    bundle.writeSignedManifest();

    await expectVerificationFailure(bundle, 'MANIFEST_INVALID');
  });

  it('fails closed when Linux carries a platform signature slot', async () => {
    const bundle = createTestOnlyEvidenceBundle();
    const linuxEvidence = bundle.manifest.platformArchives[2].evidence;
    linuxEvidence.authenticode = bundle.manifest.platformArchives[0].evidence.authenticode;
    bundle.writeSignedManifest();

    await expectVerificationFailure(bundle, 'MANIFEST_INVALID');
  });

  it('fails closed when build provenance does not bind to the source revision', async () => {
    const bundle = createTestOnlyEvidenceBundle();
    bundle.manifest.platformArchives[0].buildProvenance.sourceRevision = 'abcdef0123456789abcdef0123456789abcdef01';
    bundle.writeSignedManifest();

    await expectVerificationFailure(bundle, 'VERSION_MISMATCH');
  });

  it('fails closed when patch input/output digests are missing', async () => {
    const bundle = createTestOnlyEvidenceBundle();
    delete bundle.manifest.openclaw.patch.targetFiles[0].output.sha512;
    bundle.writeSignedManifest();

    await expectVerificationFailure(bundle, 'MANIFEST_INVALID');
  });

  it('fails closed when an exact protocol pointer has no negative fixture for one platform', async () => {
    const bundle = createTestOnlyEvidenceBundle();
    bundle.manifest.fixtures = bundle.manifest.fixtures.filter(
      (fixture: Record<string, any>) => fixture.id !== 'darwin-arm64-gateway-status-handler-negative',
    );
    bundle.writeSignedManifest();

    await expectVerificationFailure(bundle, 'FIXTURE_MAPPING_INVALID');
  });

  it('fails closed when a fixture maps a handler to a different exact pointer', async () => {
    const bundle = createTestOnlyEvidenceBundle();
    bundle.manifest.fixtures[0].sourceRefs[0].pointer = 'config.get';
    bundle.writeSignedManifest();

    await expectVerificationFailure(bundle, 'FIXTURE_MAPPING_INVALID');
  });

  it('fails closed when a referenced file path escapes the bundle directory', async () => {
    const bundle = createTestOnlyEvidenceBundle();
    bundle.manifest.platformArchives[0].archive.path = '../outside/installer.bin';
    bundle.writeSignedManifest();

    await expectVerificationFailure(bundle, 'PATH_OUTSIDE_BUNDLE');
  });

  it.skipIf(process.platform === 'win32')(
    'rejects an internal symbolic link rather than resolving it inside the bundle',
    async () => {
      const bundle = createTestOnlyEvidenceBundle();
      const source = bundle.manifest.openclaw.sourceArchive;
      const linkPath = 'sources/openclaw-source-link.tar.gz';
      fs.symlinkSync('openclaw-source.tar.gz', path.join(bundle.root, linkPath));
      bundle.manifest.openclaw.sourceArchive = { path: linkPath, ...hashFileContent(fs.readFileSync(path.join(bundle.root, source.path))) };
      bundle.writeSignedManifest();

      await expectVerificationFailure(bundle, 'PATH_OUTSIDE_BUNDLE');
    },
  );

  it('rejects two logical references to the same physical file', async () => {
    const bundle = createTestOnlyEvidenceBundle();
    const archive = bundle.manifest.platformArchives[0].archive;
    const payload = bundle.manifest.platformArchives[0].payloads[0].file;
    const payloadPath = path.join(bundle.root, payload.path);
    fs.unlinkSync(payloadPath);
    fs.linkSync(path.join(bundle.root, archive.path), payloadPath);
    Object.assign(payload, archiveBinding(archive));
    bundle.writeSignedManifest();

    await expectVerificationFailure(bundle, 'MANIFEST_INVALID');
  });

  it('rejects a timestamp that Date.parse would normalize', async () => {
    const bundle = createTestOnlyEvidenceBundle();
    bundle.manifest.platformArchives[0].buildProvenance.startedAt = '2025-02-31T00:00:00Z';
    bundle.writeSignedManifest();

    await expectVerificationFailure(bundle, 'MANIFEST_INVALID');
  });

  it('rejects an artifact signature that is hash-bound but not trusted', async () => {
    const bundle = createTestOnlyEvidenceBundle();
    const signaturePath = path.join(bundle.root, 'artifacts/win32-x64/installer.sig');
    const invalidSignature = 'test-only-invalid-artifact-signature';
    fs.writeFileSync(signaturePath, invalidSignature);
    Object.assign(
      bundle.manifest.platformArchives[0].evidence.artifactSignature.file,
      hashFileContent(invalidSignature),
    );
    bundle.writeSignedManifest();

    await expectVerificationFailure(bundle, 'ARTIFACT_SIGNATURE_INVALID');
  });

  it('rejects a non-canonical base64 artifact signature before importing', async () => {
    const bundle = createTestOnlyEvidenceBundle();
    const signaturePath = path.join(bundle.root, 'artifacts/win32-x64/installer.sig');
    const signature = fs.readFileSync(signaturePath, 'utf8');
    const nonCanonicalSignature = `${signature}\n`;
    fs.writeFileSync(signaturePath, nonCanonicalSignature);
    Object.assign(
      bundle.manifest.platformArchives[0].evidence.artifactSignature.file,
      hashFileContent(nonCanonicalSignature),
    );
    bundle.writeSignedManifest();

    await expectVerificationFailure(bundle, 'ARTIFACT_SIGNATURE_INVALID');
  });

  it('imports only a verified bundle through a staging directory', async () => {
    const bundle = createTestOnlyEvidenceBundle();
    const destinationDirectory = path.join(
      path.dirname(bundle.root),
      `imported-openclaw-evidence-${crypto.randomUUID()}`,
    );

    const receipt = await importHistoricalOpenClawEvidenceBundle({
      bundleDirectory: bundle.root,
      destinationDirectory,
      trustedPublicKeyPem: bundle.trustedPublicKeyPem,
      trustedArtifactPublicKeyPem: bundle.trustedArtifactPublicKeyPem,
    });

    expect(receipt).toMatchObject({ status: 'verified', import: { status: 'imported' } });
    expect(fs.existsSync(path.join(destinationDirectory, 'manifest.json'))).toBe(true);
    expect(fs.readdirSync(path.dirname(destinationDirectory))).not.toContainEqual(
      expect.stringMatching(/^\.historical-openclaw-evidence-import-/),
    );
  });

  it('never creates an import destination for a tampered bundle', async () => {
    const bundle = createTestOnlyEvidenceBundle();
    const destinationDirectory = path.join(
      path.dirname(bundle.root),
      `rejected-openclaw-evidence-${crypto.randomUUID()}`,
    );
    fs.writeFileSync(path.join(bundle.root, 'artifacts/win32-x64/installer.bin'), 'tampered archive bytes');

    await expect(
      importHistoricalOpenClawEvidenceBundle({
        bundleDirectory: bundle.root,
        destinationDirectory,
        trustedPublicKeyPem: bundle.trustedPublicKeyPem,
        trustedArtifactPublicKeyPem: bundle.trustedArtifactPublicKeyPem,
      }),
    ).rejects.toMatchObject({ code: 'HASH_MISMATCH' });

    expect(fs.existsSync(destinationDirectory)).toBe(false);
    expect(fs.readdirSync(path.dirname(destinationDirectory))).not.toContainEqual(
      expect.stringMatching(/^\.historical-openclaw-evidence-import-/),
    );
  });

  it('refuses to overwrite an existing import destination', async () => {
    const bundle = createTestOnlyEvidenceBundle();
    const destinationDirectory = path.join(
      path.dirname(bundle.root),
      `existing-openclaw-evidence-${crypto.randomUUID()}`,
    );
    fs.mkdirSync(destinationDirectory);

    await expect(
      importHistoricalOpenClawEvidenceBundle({
        bundleDirectory: bundle.root,
        destinationDirectory,
        trustedPublicKeyPem: bundle.trustedPublicKeyPem,
        trustedArtifactPublicKeyPem: bundle.trustedArtifactPublicKeyPem,
      }),
    ).rejects.toMatchObject({ code: 'IMPORT_DESTINATION_EXISTS' });

    expect(fs.readdirSync(destinationDirectory)).toEqual([]);
  });

  it('prints only a safe rejection receipt for a tampered v2 bundle', () => {
    const bundle = createTestOnlyEvidenceBundle();
    fs.writeFileSync(path.join(bundle.root, 'artifacts/win32-x64/installer.bin'), 'tampered archive bytes');
    const trustedPublicKeyPath = path.join(bundle.root, 'trusted-public-key.pem');
    const trustedArtifactPublicKeyPath = path.join(bundle.root, 'trusted-artifact-public-key.pem');
    fs.writeFileSync(trustedPublicKeyPath, bundle.trustedPublicKeyPem);
    fs.writeFileSync(trustedArtifactPublicKeyPath, bundle.trustedArtifactPublicKeyPem);

    const result = spawnSync(
      process.execPath,
      [
        VERIFIER_SCRIPT,
        '--bundle',
        bundle.root,
        '--trusted-public-key',
        trustedPublicKeyPath,
        '--trusted-artifact-public-key',
        trustedArtifactPublicKeyPath,
      ],
      { encoding: 'utf8' },
    );

    expect(result.status).toBe(1);
    expect(result.stderr).toBe('');
    expect(result.stdout).toBe('{"receiptVersion":1,"status":"rejected","code":"HASH_MISMATCH"}\n');
    expect(result.stdout).not.toContain(bundle.root);
    expect(result.stdout).not.toContain('archive.example.test');
  });
});
