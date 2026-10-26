import { Ensure, equals } from '@serenity-js/assertions';
import { test } from '../../fixtures/serenity.js';
import { OriginalWorldPackageRecovery, OriginalWorldPackageUpload, WorldPackageUpload } from '../../questions/world-package-upload.question.js';
import { InspectOriginalWorldPackageUpload, InspectRepairedWorldPackageUpload, RecoverOriginalWorldPackageUpload, RefreshOriginalWorldPackageUpload, RefreshWorldPackageUploadReceipt, UploadTruncatedWorldPackage } from '../../tasks/world-package-upload.task.js';
import { LeaveWorldWorkspace } from '../../tasks/world-workspace.task.js';

test('World package 上传回执：4 字节截断 ZIP 仅安装一次，完整 invalid_archive 失败且刷新保留同身份与终态', async ({ actor }) => {
  let primaryFailure: unknown;
  try {
    await actor.attemptsTo(
      UploadTruncatedWorldPackage(),
      Ensure.that(WorldPackageUpload().attempts, equals(1)),
      Ensure.that(WorldPackageUpload().submission.kind, equals('install_package')),
      Ensure.that(WorldPackageUpload().upload.received, equals('4')),
      Ensure.that(WorldPackageUpload().upload.state, equals(WorldPackageUpload().digest.as(digest => ({ kind: 'sealed', blob: { byteSize: '4', digest } })))),
      Ensure.that(WorldPackageUpload().receipt.phase, equals('failed')),
      Ensure.that(WorldPackageUpload().receipt.disclosure.kind, equals('full')),
      Ensure.that(WorldPackageUpload().receipt.failure.code, equals('world.package.failed')),
      Ensure.that(WorldPackageUpload().receipt.failure.stage, equals('verify')),
      Ensure.that(WorldPackageUpload().receipt.failure.details, equals({ kind: 'package', failure: { kind: 'invalid_archive' } })),
      RefreshWorldPackageUploadReceipt(),
      Ensure.that(WorldPackageUpload().refreshed, equals(true)),
      Ensure.that(WorldPackageUpload().unchanged, equals({ inventory: true, activeRelease: true })),
      Ensure.that(WorldPackageUpload().attempts, equals(1)),
    );
  } catch (error) {
    primaryFailure = error;
    throw error;
  } finally {
    try { await actor.attemptsTo(LeaveWorldWorkspace()); }
    catch (cleanupFailure) {
      throw new AggregateError(primaryFailure === undefined ? [cleanupFailure] : [primaryFailure, cleanupFailure],
        'World package upload retained its original failure and workspace cleanup failure; no replay or abort');
    }
  }
});

test('World package r28 原上传只读回执：同原身份、full 终态与刷新后同回执，零提交不恢复', async ({ actor }) => {
  let primaryFailure: unknown;
  try {
    await actor.attemptsTo(
      InspectOriginalWorldPackageUpload(),
      Ensure.that(OriginalWorldPackageUpload().sameIdentity, equals(true)),
      Ensure.that(OriginalWorldPackageUpload().full, equals(true)),
      Ensure.that(OriginalWorldPackageUpload().statusResultEqual, equals(true)),
      Ensure.that(OriginalWorldPackageUpload().attempts, equals(0)),
      RefreshOriginalWorldPackageUpload(),
      Ensure.that(OriginalWorldPackageUpload().refreshed, equals(true)),
      Ensure.that(OriginalWorldPackageUpload().sameIdentity, equals(true)),
      Ensure.that(OriginalWorldPackageUpload().full, equals(true)),
      Ensure.that(OriginalWorldPackageUpload().statusResultEqual, equals(true)),
      Ensure.that(OriginalWorldPackageUpload().attempts, equals(0)),
    );
  } catch (error) {
    primaryFailure = error;
    throw error;
  } finally {
    try { await actor.attemptsTo(LeaveWorldWorkspace()); }
    catch (cleanupFailure) {
      throw new AggregateError(primaryFailure === undefined ? [cleanupFailure] : [primaryFailure, cleanupFailure],
        'Original r28 package readback retained its primary and workspace cleanup failures; zero submissions');
    }
  }
});

test('World package r28 原操作显式恢复：修复工件证据绑定、Resume 仅一次、同原终态回执且零上传', async ({ actor }) => {
  let primaryFailure: unknown;
  try {
    await actor.attemptsTo(
      RecoverOriginalWorldPackageUpload(),
      Ensure.that(OriginalWorldPackageRecovery().resumeAttempts, equals(1)),
      Ensure.that(OriginalWorldPackageRecovery().phase, equals('terminal')),
      Ensure.that(OriginalWorldPackageUpload().attempts, equals(0)),
      Ensure.that(OriginalWorldPackageUpload().sameIdentity, equals(true)),
      Ensure.that(OriginalWorldPackageUpload().full, equals(true)),
      Ensure.that(OriginalWorldPackageUpload().statusResultEqual, equals(true)),
      RefreshOriginalWorldPackageUpload(),
      Ensure.that(OriginalWorldPackageUpload().refreshed, equals(true)),
      Ensure.that(OriginalWorldPackageRecovery().resumeAttempts, equals(1)),
      Ensure.that(OriginalWorldPackageUpload().attempts, equals(0)),
    );
  } catch (error) {
    primaryFailure = error;
    throw error;
  } finally {
    try { await actor.attemptsTo(LeaveWorldWorkspace()); }
    catch (cleanupFailure) {
      throw new AggregateError(primaryFailure === undefined ? [cleanupFailure] : [primaryFailure, cleanupFailure],
        'Explicit original package recovery retained its primary and cleanup failures; no further Resume or upload');
    }
  }
});

test('World package 修复工件安装回执：只读核对本次 invalid_archive、原清单与发布不变、刷新同终态，零提交', async ({ actor }) => {
  let primaryFailure: unknown;
  try {
    await actor.attemptsTo(
      InspectRepairedWorldPackageUpload(),
      Ensure.that(WorldPackageUpload().receipt.phase, equals('failed')),
      Ensure.that(WorldPackageUpload().receipt.disclosure.kind, equals('full')),
      Ensure.that(WorldPackageUpload().receipt.failure.code, equals('world.package.failed')),
      Ensure.that(WorldPackageUpload().receipt.failure.stage, equals('verify')),
      Ensure.that(WorldPackageUpload().receipt.failure.details, equals({ kind: 'package', failure: { kind: 'invalid_archive' } })),
      Ensure.that(WorldPackageUpload().unchanged, equals({ inventory: true, activeRelease: true })),
      RefreshWorldPackageUploadReceipt(),
      Ensure.that(WorldPackageUpload().refreshed, equals(true)),
      Ensure.that(WorldPackageUpload().attempts, equals(1)),
    );
  } catch (error) {
    primaryFailure = error;
    throw error;
  } finally {
    try { await actor.attemptsTo(LeaveWorldWorkspace()); }
    catch (cleanupFailure) {
      throw new AggregateError(primaryFailure === undefined ? [cleanupFailure] : [primaryFailure, cleanupFailure],
        'Repaired package readback retained its primary and cleanup failures; zero new submissions');
    }
  }
});
