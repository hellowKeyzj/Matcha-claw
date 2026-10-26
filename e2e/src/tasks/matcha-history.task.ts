import { Check, Duration, Log, Task, Wait } from '@serenity-js/core';
import { equals } from '@serenity-js/assertions';
import { Clear, Click, Enter, isEnabled, isVisible } from '@serenity-js/web';
import {
  CaptureMatchaMarkdown, CaptureMatchaPublicHistory, CompleteMatchaHistoryTurn, CreateMatchaHistorySession,
  DeleteMatchaHistorySession, ExpandMatchaHistorySessionBuckets, PrepareMatchaHistoryAbility, PrepareMatchaHistoryUiTurn,
  RecoverMatchaHistoryAfterNativeRestart, RestoreMatchaHistorySessionBuckets,
} from '../interactions/matcha-history.interaction.js';
import { ChatPage } from '../pages/chat.page.js';
import { MatchaHistoryPage } from '../pages/matcha-history.page.js';
import { SessionDirectoryIsReady } from '../questions/chat.question.js';
import { MatchaHistoryCleanup, MatchaHistoryNewDraftSelector, MatchaHistoryPrompt, MatchaHistoryRecoveryEvidence, MatchaHistorySessionSelector } from '../questions/matcha-history.question.js';
import { EnterChat } from './chat.task.js';

export const PrepareMatchaHistory = () => Task.where('#actor enters usable Chat and reads the current ready Matcha default Agent without changing runtime settings',
  EnterChat(),
  PrepareMatchaHistoryAbility(),
);

export const CleanUpMatchaHistory = () => Task.where('#actor precisely cleans its owned history session while retaining unknown native outcomes for inspection',
  DeleteMatchaHistorySession(),
  Log.the(MatchaHistoryCleanup()),
);

export const CreatePublicMatchaHistory = () => Task.where('#actor verifies public Matcha session creation independently of the UI history journey',
  CreateMatchaHistorySession(),
);

export const StartMatchaHistoryDraft = () => Task.where('#actor opens a new draft through the exact default Agent in the Matcha runtime group',
  Click.on(ChatPage.identity),
  Click.on(ChatPage.agentsTab),
  Wait.upTo(Duration.ofSeconds(45)).until(MatchaHistoryPage.newDraft(MatchaHistoryNewDraftSelector()), isEnabled()),
  Click.on(MatchaHistoryPage.newDraft(MatchaHistoryNewDraftSelector())),
  Wait.until(MatchaHistoryPage.switchboards.count(), equals(0)),
  Wait.upTo(Duration.ofSeconds(15)).until(ChatPage.input, isEnabled()),
);

export const RunMatchaHistoryTurn = () => Task.where('#actor sends once through the current Matcha composer and waits for the exact native completed terminal',
  Wait.upTo(Duration.ofSeconds(15)).until(ChatPage.input, isEnabled()),
  Clear.theValueOf(ChatPage.input),
  Enter.theValue(MatchaHistoryPrompt()).into(ChatPage.input),
  Wait.upTo(Duration.ofSeconds(15)).until(MatchaHistoryPage.send, isEnabled()),
  PrepareMatchaHistoryUiTurn(),
  Click.on(MatchaHistoryPage.send),
  CompleteMatchaHistoryTurn(),
);

export const ReadMatchaHistory = () => Task.where('#actor verifies redacted canonical history and records only its public recovery identity and digest',
  CaptureMatchaPublicHistory(),
  Log.the(MatchaHistoryRecoveryEvidence()),
);

export const OpenMatchaHistory = () => Task.where('#actor opens this exact Matcha session from the public ordinary session directory',
  Click.on(ChatPage.identity),
  Click.on(ChatPage.sessionsTab),
  Wait.upTo(Duration.ofSeconds(45)).until(SessionDirectoryIsReady(), equals(true)),
  Check.whether(ChatPage.normalSessionsTab, isVisible()).andIfSo(Click.on(ChatPage.normalSessionsTab)),
  ExpandMatchaHistorySessionBuckets(),
  Wait.upTo(Duration.ofSeconds(45)).until(ChatPage.session(MatchaHistorySessionSelector()), isVisible()),
  Click.on(ChatPage.session(MatchaHistorySessionSelector())),
  Wait.until(MatchaHistoryPage.switchboards.count(), equals(0)),
  RestoreMatchaHistorySessionBuckets(),
);

export const RecoverMatchaHistory = () => Task.where('#actor preserves Electron ownership while recovering identical public history across a native app-server process restart',
  RecoverMatchaHistoryAfterNativeRestart(),
);

export const ExportMatchaHistory = () => Task.where('#actor exports this session through its enabled Markdown toolbar action',
  Wait.upTo(Duration.ofSeconds(15)).until(MatchaHistoryPage.exportMarkdown, isEnabled()),
  CaptureMatchaMarkdown(),
);
