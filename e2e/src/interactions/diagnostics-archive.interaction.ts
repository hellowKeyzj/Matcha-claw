import { equals, not } from '@serenity-js/assertions';
import { Duration, Interaction, Wait, notes } from '@serenity-js/core';
import { Click, Value, isEnabled, isVisible } from '@serenity-js/web';
import { DiagnosticsArchive } from '../abilities/diagnostics-archive.ability.js';
import { DiagnosticsArchivePage } from '../pages/diagnostics-archive.page.js';

export const ExportFreshDiagnosticsArchive = () => Interaction.where('#actor saves and inspects only this run\'s local diagnostics export without reading its contents', async actor => {
  const archive = actor.abilityTo(DiagnosticsArchive);
  const previousId = await actor.answer(DiagnosticsArchivePage.archiveId.isPresent())
    ? await actor.answer(Value.of(DiagnosticsArchivePage.archiveId)) : '';
  const failures: unknown[] = [];
  try {
    await archive.prepare();
    await Click.on(DiagnosticsArchivePage.export).performAs(actor);
    await Wait.upTo(Duration.ofSeconds(45)).until(DiagnosticsArchivePage.saved, isVisible()).performAs(actor);
    await Wait.until(DiagnosticsArchivePage.export, isEnabled()).performAs(actor);
    await Wait.until(Value.of(DiagnosticsArchivePage.archiveId), not(equals(previousId))).performAs(actor);
    await notes<{ diagnosticsArchiveSavedBytes: number }>().set('diagnosticsArchiveSavedBytes', await archive.savedBytes()).performAs(actor);
  } catch (error) { failures.push(error); }
  finally {
    try { await archive.discard(); } catch (error) { failures.push(error); }
  }
  if (failures.length === 1) throw failures[0];
  if (failures.length > 1) throw new AggregateError(failures, 'Diagnostics export failed; cleanup errors retain the original failure');
});
