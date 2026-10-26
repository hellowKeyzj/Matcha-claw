import { Question, notes } from '@serenity-js/core';
import { Text, Value } from '@serenity-js/web';
import { DiagnosticsArchivePage } from '../pages/diagnostics-archive.page.js';

export const DiagnosticsArchiveId = () => Value.of(DiagnosticsArchivePage.archiveId);
export const DiagnosticsArchivePageText = () => Text.of(DiagnosticsArchivePage.body);
export const DiagnosticsArchiveWasSaved = () => DiagnosticsArchivePage.saved.isVisible();
export const DiagnosticsArchiveLocalBytes = () => notes<{ diagnosticsArchiveSavedBytes: number }>().get('diagnosticsArchiveSavedBytes');
export const DiagnosticsArchiveReportedBytes = () => Question.about('the saved archive byte count reported by Rust', async actor => {
  const metadata = await actor.answer(Text.of(DiagnosticsArchivePage.metadata));
  const match = /^(?:Entries: [0-9]+, bytes: |条目数：[0-9]+，字节数：)([0-9]+)$/.exec(metadata);
  if (!match) throw new Error('Diagnostics archive metadata does not contain the expected public entry and byte counts');
  return Number(match[1]);
});
