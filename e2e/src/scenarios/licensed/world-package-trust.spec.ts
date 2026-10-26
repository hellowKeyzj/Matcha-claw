import { Ensure, equals } from '@serenity-js/assertions';
import { test } from '../../fixtures/serenity.js';
import {
  WorldTrustAfterCancel, WorldTrustAfterRefresh, WorldTrustBaseline, WorldTrustConfirmation, WorldTrustDraft,
  WorldTrustDuplicate, WorldTrustInvalid, WorldTrustRemoved,
} from '../../questions/world-package-trust.question.js';
import {
  CancelWorldTrustReplacement, InspectWorldTrustDraft, OpenWorldTrustDraft, RefreshWorldTrustDraft, RemoveOwnWorldTrustDraft,
} from '../../tasks/world-package-trust.task.js';
import { LeaveWorldWorkspace } from '../../tasks/world-workspace.task.js';

test('World 包信任公钥仅草稿：拒绝非法与重复、完整预览后取消，刷新清草稿且全量策略和修订不变', async ({ actor }) => {
  await actor.attemptsTo(
    OpenWorldTrustDraft(), InspectWorldTrustDraft(),
    Ensure.that(WorldTrustInvalid(), equals({ invalidHex: true, short: true, long: true, noDraft: true })),
    Ensure.that(WorldTrustDraft().ownRoots, equals(1)), Ensure.that(WorldTrustDraft().flags, equals([false, false])),
    Ensure.that(WorldTrustDraft().fullPreview, equals(true)), Ensure.that(WorldTrustDuplicate(), equals(WorldTrustDraft())),
    RemoveOwnWorldTrustDraft(),
    Ensure.that(WorldTrustRemoved().ownRoots, equals(0)), Ensure.that(WorldTrustRemoved().previewCount, equals(0)),
    Ensure.that(WorldTrustRemoved().canSubmit, equals(false)),
    CancelWorldTrustReplacement(),
    Ensure.that(WorldTrustConfirmation().risks, equals([true, true, true])),
    Ensure.that(WorldTrustAfterCancel().policy, equals(WorldTrustBaseline().policy)),
    Ensure.that(WorldTrustAfterCancel().policy.revision, equals(WorldTrustBaseline().policy.revision)),
    Ensure.that(WorldTrustAfterCancel().draft, equals(WorldTrustDraft())),
    RefreshWorldTrustDraft(),
    Ensure.that(WorldTrustAfterRefresh().policy, equals(WorldTrustBaseline().policy)),
    Ensure.that(WorldTrustAfterRefresh().policy.revision, equals(WorldTrustBaseline().policy.revision)),
    Ensure.that(WorldTrustAfterRefresh().draft, equals(WorldTrustRemoved())), LeaveWorldWorkspace(),
  );
});
