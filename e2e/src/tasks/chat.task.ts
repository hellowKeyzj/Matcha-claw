import { Check, Duration, Task, Wait, notes } from '@serenity-js/core';
import { equals, isGreaterThan } from '@serenity-js/assertions';
import { Click, Enter, Hover, Navigate, isEnabled, isVisible } from '@serenity-js/web';
import { DropPng, ExpandSessionBuckets, ObserveSentImage, RememberPngSession, RememberPngSessionBaseline } from '../interactions/chat.interaction.js';
import { AccountPage } from '../pages/account.page.js';
import { ChatPage } from '../pages/chat.page.js';
import {
  ChatEntryIsVisible, ChatIsVisible, CurrentSessionCount, PngIsReady, PngSessionSelector, SavedArtifactSectionSelector, SavedPanelTabSelector,
  SavedWorkspacePanelState, SessionCount, SessionDirectoryIsReady, WorkspacePanelIsFullscreen, WorkspacePanelState, WorkspacePanelStateWasSaved, WorkspacePanelWasOpen,
} from '../questions/chat.question.js';

export const EnterChat = () => Task.where('#actor enters the usable local Chat through the UI',
  Wait.upTo(Duration.ofSeconds(45)).until(ChatEntryIsVisible(), equals(true)),
  Check.whether(AccountPage.continueLocally, isVisible()).andIfSo(Click.on(AccountPage.continueLocally)),
  Check.whether(ChatPage.otherPage, isVisible()).andIfSo(
    Check.whether(AccountPage.expandSidebar, isVisible()).andIfSo(Click.on(AccountPage.expandSidebar)),
    Click.on(ChatPage.newChat),
  ),
  Check.whether(ChatPage.fullscreenPanel, isVisible()).andIfSo(Click.on(ChatPage.closeSidePanel)),
  Check.whether(ChatPage.switchboard, isVisible()).andIfSo(Click.on(ChatPage.switchboardBackdrop)),
  Wait.upTo(Duration.ofSeconds(45)).until(ChatIsVisible(), equals(true)),
);

export const StartOpenClawDraft = () => Task.where('#actor starts a new OpenClaw main Agent draft',
  Click.on(ChatPage.identity),
  Click.on(ChatPage.agentsTab),
  Wait.upTo(Duration.ofSeconds(45)).until(ChatPage.newOpenClawSession, isEnabled()),
  Hover.over(ChatPage.openClawAgent),
  Click.on(ChatPage.newOpenClawSession),
  Wait.until(ChatPage.switchboard.isVisible(), equals(false)),
  Wait.until(ChatIsVisible(), equals(true)),
);

export const SaveWorkspacePanel = () => Task.where('#actor saves the side panel state before leaving Chat',
  notes<{ workspacePanelWasOpen: boolean }>().set('workspacePanelWasOpen', ChatPage.sidePanel.isVisible()),
  Check.whether(ChatPage.sidePanel, isVisible()).andIfSo().otherwise(Click.on(ChatPage.openSidePanel)),
  Wait.until(ChatPage.sidePanel, isVisible()),
  notes().set('workspacePanelState', WorkspacePanelState()),
  Click.on(ChatPage.closeSidePanel),
);

export const OpenWorkspace = () => Task.where('#actor opens the selected Agent workspace in the right panel',
  Check.whether(ChatPage.sidePanel, isVisible()).andIfSo().otherwise(Click.on(ChatPage.openSidePanel)),
  Click.on(ChatPage.artifactsTab),
  Click.on(ChatPage.workspaceTab),
  Wait.until(ChatPage.workspace, isVisible()),
  Check.whether(ChatPage.expandWorkspaceTree, isVisible()).andIfSo(Click.on(ChatPage.expandWorkspaceTree)),
);

export const PreviewAgentsFile = () => Task.where('#actor previews the real workspace AGENTS.md',
  Wait.until(ChatPage.agentsFile, isVisible()),
  Click.on(ChatPage.agentsFile),
  Wait.until(ChatPage.previewHeading, isVisible()),
);

export const RestoreWorkspacePanel = () => Task.where('#actor restores the saved side panel state through the UI',
  Check.whether(WorkspacePanelStateWasSaved(), equals(true)).andIfSo(
    Check.whether(ChatPage.switchboard, isVisible()).andIfSo(Click.on(ChatPage.switchboardBackdrop)),
    EnterChat(),
    Check.whether(ChatPage.sidePanel, isVisible()).andIfSo().otherwise(Click.on(ChatPage.openSidePanel)),
    Wait.until(ChatPage.sidePanel, isVisible()),
    Check.whether(SavedWorkspacePanelState().section, equals(undefined)).andIfSo().otherwise(
      Click.on(ChatPage.artifactsTab),
      Click.on(ChatPage.artifactSection(SavedArtifactSectionSelector())),
    ),
    Click.on(ChatPage.sidePanelTab(SavedPanelTabSelector())),
    Check.whether(WorkspacePanelIsFullscreen(), equals(SavedWorkspacePanelState().fullscreen))
      .andIfSo().otherwise(Click.on(ChatPage.artifactFullscreen)),
    Check.whether(WorkspacePanelWasOpen(), equals(false)).andIfSo(Click.on(ChatPage.closeSidePanel)),
  ),
);

const ReadSessionDirectory = () => Task.where('#actor waits for the ordinary session directory and expands its time buckets',
  Wait.upTo(Duration.ofSeconds(45)).until(SessionDirectoryIsReady(), equals(true)),
  Check.whether(ChatPage.normalSessionsTab, isVisible()).andIfSo(Click.on(ChatPage.normalSessionsTab)),
  ExpandSessionBuckets(),
);

const OpenSessionDirectory = () => Task.where('#actor opens the ordinary session directory',
  Click.on(ChatPage.identity),
  Click.on(ChatPage.sessionsTab),
  ReadSessionDirectory(),
);

export const CheckSentImage = () => Task.where('#actor observes the image belonging to the sent user text',
  ObserveSentImage(),
);

export const ReloadPngSession = () => Task.where('#actor reloads the page and reopens the exact session containing the sent PNG',
  OpenSessionDirectory(),
  Wait.upTo(Duration.ofSeconds(45)).until(CurrentSessionCount(), equals(1)),
  RememberPngSession(),
  Click.on(ChatPage.switchboardBackdrop),
  Navigate.reloadPage(),
  EnterChat(),
  OpenSessionDirectory(),
  Wait.upTo(Duration.ofSeconds(45)).until(ChatPage.session(PngSessionSelector()), isVisible()),
  Click.on(ChatPage.session(PngSessionSelector())),
  Wait.until(ChatPage.switchboard.isVisible(), equals(false)),
  Wait.upTo(Duration.ofSeconds(45)).until(ChatPage.sentText, isVisible()),
  ObserveSentImage(),
);

export const AttachPng = () => Task.where('#actor drops a PNG and waits for its real ready preview',
  DropPng(),
  Wait.upTo(Duration.ofSeconds(15)).until(PngIsReady(), equals(true)),
);

export const SendImageMessage = () => Task.where('#actor sends the image from an OpenClaw draft and sees its real session in the directory',
  Click.on(ChatPage.identity),
  Click.on(ChatPage.sessionsTab),
  ReadSessionDirectory(),
  notes<{ sessionsBeforeSend: number }>().set('sessionsBeforeSend', SessionCount()),
  RememberPngSessionBaseline(),
  Click.on(ChatPage.switchboardBackdrop),
  Enter.theValue('Describe this image.').into(ChatPage.input),
  Wait.until(ChatPage.send, isEnabled()),
  Click.on(ChatPage.send),
  Wait.upTo(Duration.ofSeconds(15)).until(ChatPage.sentText, isVisible()),
  Click.on(ChatPage.identity),
  Click.on(ChatPage.sessionsTab),
  ReadSessionDirectory(),
  Wait.upTo(Duration.ofSeconds(15)).until(SessionCount(), isGreaterThan(notes<{ sessionsBeforeSend: number }>().get('sessionsBeforeSend'))),
  Wait.upTo(Duration.ofSeconds(15)).until(CurrentSessionCount(), equals(1)),
  RememberPngSession(),
  Click.on(ChatPage.switchboardBackdrop),
);
