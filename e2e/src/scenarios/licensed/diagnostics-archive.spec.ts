import { Ensure, equals, isGreaterThan, matches, not } from '@serenity-js/assertions';
import { test } from '../../fixtures/serenity.js';
import {
  DiagnosticsArchiveId, DiagnosticsArchiveLocalBytes, DiagnosticsArchivePageText, DiagnosticsArchiveReportedBytes, DiagnosticsArchiveWasSaved,
} from '../../questions/diagnostics-archive.question.js';
import { EnterChat } from '../../tasks/chat.task.js';
import { OpenDiagnosticsArchiveSettings, SaveDiagnosticsArchive } from '../../tasks/diagnostics-archive.task.js';

test('设置真实保存本次 Rust 诊断归档，公面只显示归档 ID 和统计而不泄露本地路径', async ({ actor }) => {
  const failures: unknown[] = [];
  try {
    await actor.attemptsTo(
      OpenDiagnosticsArchiveSettings(),
      SaveDiagnosticsArchive(),
      Ensure.that(DiagnosticsArchiveWasSaved(), equals(true)),
      Ensure.that(DiagnosticsArchiveId(), matches(/^[a-f0-9]{32}$/)),
      Ensure.that(DiagnosticsArchiveLocalBytes(), isGreaterThan(0)),
      Ensure.that(DiagnosticsArchiveLocalBytes(), equals(DiagnosticsArchiveReportedBytes())),
      Ensure.that(DiagnosticsArchivePageText(), not(matches(/host-diagnostics|diagnostics-archive\.zip|file:\/\/|[a-z]:[\\/]/i))),
    );
  } catch (error) { failures.push(error); }
  finally {
    try { await actor.attemptsTo(EnterChat()); } catch (error) { failures.push(error); }
  }
  if (failures.length === 1) throw failures[0];
  if (failures.length > 1) throw new AggregateError(failures, 'Diagnostics archive verification failed; cleanup errors retain the original failure');
});
