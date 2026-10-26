import { Ensure, equals } from '@serenity-js/assertions';
import { test } from '../../fixtures/serenity.js';
import {
  ChannelsBodyIsRedacted, ChannelsInvalidControlReceipt, ChannelsInvalidSnapshotReceipt, ChannelsInvalidStatusReceipt,
  ChannelsIsVisible, ChannelsPublicStateIsRedacted, ChannelsSnapshotReceipt, ChannelsStatusReceipt,
} from '../../questions/channels.question.js';
import { EnterChannels, LeaveChannels, MatchChannelsSummary, ReadChannelsPublicState, ReadChannelsRejections } from '../../tasks/channels.task.js';

test('通过自然入口到达 Channels，真实公开状态 DTO 脱敏且频道总数与 ready snapshot 一致', async ({ actor }) => {
  const failures: unknown[] = [];
  try {
    await actor.attemptsTo(
      EnterChannels(),
      Ensure.that(ChannelsIsVisible(), equals(true)),
      ReadChannelsPublicState(),
      Ensure.that(ChannelsStatusReceipt(), equals({ transportOk: true, status: 200, httpOk: true, contractValid: true })),
      Ensure.that(ChannelsSnapshotReceipt(), equals({ transportOk: true, status: 200, httpOk: true, contractValid: true, ready: true })),
      Ensure.that(ChannelsPublicStateIsRedacted(), equals(true)),
      MatchChannelsSummary(),
      Ensure.that(ChannelsBodyIsRedacted(), equals(true)),
    );
  } catch (error) { failures.push(error); }
  finally {
    try { await actor.attemptsTo(LeaveChannels()); } catch (error) { failures.push(error); }
  }
  if (failures.length === 1) throw failures[0];
  if (failures.length > 1) throw new AggregateError(failures, 'Channels verification failed; cleanup errors retain the original failure');
});

test('Channels 公开读取与控制边界分别以固定 400 和 503 拒绝无效请求，canary 不进入错误、后续 DTO 或页面', async ({ actor }) => {
  const failures: unknown[] = [];
  try {
    await actor.attemptsTo(
      EnterChannels(),
      ReadChannelsRejections(),
      Ensure.that(ChannelsInvalidStatusReceipt(), equals({ transportOk: true, status: 400, httpOk: false, contractValid: true, redacted: true })),
      Ensure.that(ChannelsInvalidSnapshotReceipt(), equals({ transportOk: true, status: 503, httpOk: false, contractValid: true, redacted: true })),
      Ensure.that(ChannelsInvalidControlReceipt(), equals({ transportOk: true, status: 400, httpOk: false, contractValid: true, redacted: true })),
      ReadChannelsPublicState(),
      Ensure.that(ChannelsStatusReceipt(), equals({ transportOk: true, status: 200, httpOk: true, contractValid: true })),
      Ensure.that(ChannelsSnapshotReceipt(), equals({ transportOk: true, status: 200, httpOk: true, contractValid: true, ready: true })),
      Ensure.that(ChannelsPublicStateIsRedacted(), equals(true)),
      MatchChannelsSummary(),
      Ensure.that(ChannelsBodyIsRedacted(), equals(true)),
    );
  } catch (error) { failures.push(error); }
  finally {
    try { await actor.attemptsTo(LeaveChannels()); } catch (error) { failures.push(error); }
  }
  if (failures.length === 1) throw failures[0];
  if (failures.length > 1) throw new AggregateError(failures, 'Channels verification failed; cleanup errors retain the original failure');
});
