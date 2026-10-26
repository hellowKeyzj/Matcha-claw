import { Duration, Task, Wait } from '@serenity-js/core';
import { Click, isEnabled, isVisible } from '@serenity-js/web';
import { ExportFreshDiagnosticsArchive } from '../interactions/diagnostics-archive.interaction.js';
import { DiagnosticsArchivePage } from '../pages/diagnostics-archive.page.js';
import { EnterChat } from './chat.task.js';

export const OpenDiagnosticsArchiveSettings = () => Task.where('#actor opens diagnostics settings through the local workspace UI',
  EnterChat(),
  Click.on(DiagnosticsArchivePage.openSettings),
  Wait.until(DiagnosticsArchivePage.settings, isVisible()),
  Click.on(DiagnosticsArchivePage.navigation),
  Wait.until(DiagnosticsArchivePage.heading, isVisible()),
  Wait.upTo(Duration.ofSeconds(45)).until(DiagnosticsArchivePage.export, isEnabled()),
);

export const SaveDiagnosticsArchive = () => Task.where('#actor exports a fresh Rust diagnostics archive and removes only its own saved copy',
  ExportFreshDiagnosticsArchive(),
);
