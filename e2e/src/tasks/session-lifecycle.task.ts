import { Check, Duration, Task, Wait } from '@serenity-js/core';
import { Ensure, equals } from '@serenity-js/assertions';
import { Clear, Click, Enter, Hover, Navigate, isEnabled, isVisible } from '@serenity-js/web';
import {
  AbortOwnedLifecycleTurn, CleanUpOwnedLifecycleSession, CompleteOwnedLifecycleTurn, ConfirmOwnedLifecyclePersistence,
  CreateOwnedLifecycleSession, DeleteOwnedLifecycleSession, ExpandLifecycleCatalogBuckets,
  PrepareLifecycleDeletion, PrepareLifecycleStop, PrepareLifecycleTurn, RenameOwnedLifecycleSession, RestoreLifecycleCatalogBuckets,
} from '../interactions/session-lifecycle.interaction.js';
import { ChatPage } from '../pages/chat.page.js';
import { SessionLifecyclePage } from '../pages/session-lifecycle.page.js';
import { SessionDirectoryIsReady } from '../questions/chat.question.js';
import {
  LifecycleAssistantIsVisible, LifecycleCancellationPrompt, LifecycleCatalogEntryIsPresent, LifecycleCatalogTitle,
  LifecycleDeleteDialogMatches, LifecyclePrompt, LifecycleSelector, LifecycleTitle, LifecycleUserIsVisible,
} from '../questions/session-lifecycle.question.js';
import { EnterChat } from './chat.task.js';

export const CreateLifecycleSession = () => Task.where('#actor prepares one isolated native session for the Chat lifecycle journey', CreateOwnedLifecycleSession());

export const RenameLifecycleSession = () => Task.where('#actor renames its session through the current switchboard editor and reads the native label back',
  Wait.upTo(Duration.ofSeconds(8)).until(LifecycleCatalogEntryIsPresent(), equals(true)),
  Hover.over(ChatPage.session(LifecycleSelector())),
  Click.on(SessionLifecyclePage.rename(LifecycleSelector())),
  Wait.until(SessionLifecyclePage.renameInput, isEnabled()),
  Clear.theValueOf(SessionLifecyclePage.renameInput),
  Enter.theValue(LifecycleTitle()).into(SessionLifecyclePage.renameInput),
  Click.on(SessionLifecyclePage.saveRename),
  Wait.upTo(Duration.ofSeconds(8)).until(SessionLifecyclePage.renameInput.isPresent(), equals(false)),
  RenameOwnedLifecycleSession(),
  Ensure.that(LifecycleCatalogTitle(), equals(LifecycleTitle())),
);

export const CompleteLifecycleTurn = () => Task.where('#actor sends once through the composer and verifies a real completed native turn',
  Wait.upTo(Duration.ofSeconds(8)).until(ChatPage.input, isEnabled()),
  Clear.theValueOf(ChatPage.input),
  Enter.theValue(LifecyclePrompt()).into(ChatPage.input),
  Wait.upTo(Duration.ofSeconds(8)).until(SessionLifecyclePage.send, isEnabled()),
  PrepareLifecycleTurn(),
  Click.on(SessionLifecyclePage.send),
  CompleteOwnedLifecycleTurn(),
  Wait.upTo(Duration.ofSeconds(8)).until(LifecycleUserIsVisible(), equals(true)),
  Wait.upTo(Duration.ofSeconds(8)).until(LifecycleAssistantIsVisible(), equals(true)),
);

export const VerifyLifecyclePersistence = () => Task.where('#actor verifies native final-turn persistence and its reloaded UI',
  ConfirmOwnedLifecyclePersistence(),
  Wait.upTo(Duration.ofSeconds(8)).until(LifecycleUserIsVisible(), equals(true)),
  Wait.upTo(Duration.ofSeconds(8)).until(LifecycleAssistantIsVisible(), equals(true)),
);

export const CancelLifecycleTurn = () => Task.where('#actor sends a second prompt and stops its confirmed active native run through the composer',
  Wait.upTo(Duration.ofSeconds(8)).until(ChatPage.input, isEnabled()),
  Clear.theValueOf(ChatPage.input),
  Enter.theValue(LifecycleCancellationPrompt()).into(ChatPage.input),
  Wait.upTo(Duration.ofSeconds(8)).until(SessionLifecyclePage.send, isEnabled()),
  PrepareLifecycleTurn(true),
  Click.on(SessionLifecyclePage.send),
  Wait.upTo(Duration.ofSeconds(8)).until(SessionLifecyclePage.stop, isEnabled()),
  PrepareLifecycleStop(),
  Click.on(SessionLifecyclePage.stop),
  AbortOwnedLifecycleTurn(),
  Wait.upTo(Duration.ofSeconds(8)).until(SessionLifecyclePage.stop.isPresent(), equals(false)),
);

export const DeleteLifecycleSession = () => Task.where('#actor confirms deletion in the current application dialog and verifies native catalog absence',
  Click.on(ChatPage.identity),
  Click.on(ChatPage.sessionsTab),
  Wait.upTo(Duration.ofSeconds(8)).until(SessionDirectoryIsReady(), equals(true)),
  Check.whether(ChatPage.normalSessionsTab, isVisible()).andIfSo(Click.on(ChatPage.normalSessionsTab)),
  ExpandLifecycleCatalogBuckets(),
  Hover.over(ChatPage.session(LifecycleSelector())),
  Click.on(SessionLifecyclePage.delete(LifecycleSelector())),
  Wait.until(SessionLifecyclePage.deleteDialog, isVisible()),
  Ensure.that(LifecycleDeleteDialogMatches(), equals(true)),
  Wait.until(SessionLifecyclePage.confirmDelete, isEnabled()),
  PrepareLifecycleDeletion(),
  Click.on(SessionLifecyclePage.confirmDelete),
  Wait.upTo(Duration.ofSeconds(8)).until(SessionLifecyclePage.deleteDialog.isPresent(), equals(false)),
  DeleteOwnedLifecycleSession(),
  Ensure.that(LifecycleCatalogEntryIsPresent(), equals(false)),
  RestoreLifecycleCatalogBuckets(),
  Click.on(ChatPage.switchboardBackdrop),
);

export const ReloadLifecycleCatalog = () => Task.where('#actor reloads only the renderer and opens its ordinary session catalog',
  Check.whether(ChatPage.switchboard, isVisible()).andIfSo(
    RestoreLifecycleCatalogBuckets(),
    Click.on(ChatPage.switchboardBackdrop),
  ),
  Navigate.reloadPage(),
  EnterChat(),
  Click.on(ChatPage.identity),
  Click.on(ChatPage.sessionsTab),
  Wait.upTo(Duration.ofSeconds(8)).until(SessionDirectoryIsReady(), equals(true)),
  Check.whether(ChatPage.normalSessionsTab, isVisible()).andIfSo(Click.on(ChatPage.normalSessionsTab)),
  ExpandLifecycleCatalogBuckets(),
);

export const OpenLifecycleSession = () => Task.where('#actor opens only the exact lifecycle session from the visible catalog',
  Wait.upTo(Duration.ofSeconds(8)).until(LifecycleCatalogEntryIsPresent(), equals(true)),
  Click.on(ChatPage.session(LifecycleSelector())),
  Click.on(ChatPage.identity),
  Click.on(ChatPage.sessionsTab),
  Wait.upTo(Duration.ofSeconds(8)).until(SessionDirectoryIsReady(), equals(true)),
  RestoreLifecycleCatalogBuckets(),
  Click.on(ChatPage.switchboardBackdrop),
);

export const RestoreLifecycleSession = () => Task.where('#actor restores UI changes and cleans up only its own lifecycle resource', CleanUpOwnedLifecycleSession());
