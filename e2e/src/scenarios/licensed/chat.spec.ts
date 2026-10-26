import { Ensure, equals, includes, matches, not } from '@serenity-js/assertions';
import { Duration } from '@serenity-js/core';
import { test } from '../../fixtures/serenity.js';
import {
  AgentsFileIsVisible, AgentsPreviewText, AgentsPreviewTitleIsVisible, ChatBodyText, ChatInputValue,
  ChatIsVisible, PngIsReady, SelectedAgent, SentImageIsDecoded, SentImageIsVisible, SentImageSource, SentMessageText, SentUserText,
  SessionErrorCount, UserMessageCount, WorkspaceText,
} from '../../questions/chat.question.js';
import { PublicSessionWasCreated } from '../../questions/session-capabilities.question.js';
import {
  AttachPng, CheckSentImage, EnterChat, OpenWorkspace, PreviewAgentsFile, ReloadPngSession, RestoreWorkspacePanel, SaveWorkspacePanel,
  SendImageMessage, StartOpenClawDraft,
} from '../../tasks/chat.task.js';
import { CreatePublicSession, RestorePublicAttachmentSession } from '../../tasks/session-capabilities.task.js';
import { CreateWorkspaceAgent, DeleteWorkspaceAgent, DismissAgentDialogs, OpenWorkspaceAgentChat } from '../../tasks/agent.task.js';

test('应用真实启动后可进入完整可用的 Chat', async ({ actor }) => {
  await actor.attemptsTo(
    EnterChat(),
    Ensure.that(ChatIsVisible(), equals(true)),
  );
});

test('真实创建 OpenClaw 会话并预览独立 Agent workspace 的 AGENTS.md', async ({ actor }) => {
  const failures: unknown[] = [];
  try {
    await actor.attemptsTo(
      EnterChat(),
      StartOpenClawDraft(),
      Ensure.that(SelectedAgent(), includes('OpenClaw')),
      Ensure.that(ChatInputValue(), equals('')),
      Ensure.that(UserMessageCount(), equals(0)),
      CreatePublicSession(),
      Ensure.that(PublicSessionWasCreated(), equals(true)),
      SaveWorkspacePanel(),
      CreateWorkspaceAgent(),
      OpenWorkspaceAgentChat(),
      OpenWorkspace(),
      Ensure.eventually(AgentsFileIsVisible(), equals(true)),
      Ensure.that(WorkspaceText(), not(includes('e2e-profile-closure-2'))),
      PreviewAgentsFile(),
      Ensure.that(AgentsPreviewTitleIsVisible(), equals(true)),
      Ensure.that(AgentsPreviewText(), includes('你是 Matcha，MatchaClaw 的日常办公桌面 Agent。')),
    );
  } catch (error) { failures.push(error); }
  finally {
    for (const cleanup of [DeleteWorkspaceAgent(), DismissAgentDialogs(), RestoreWorkspacePanel(), RestorePublicAttachmentSession()]) {
      try { await actor.attemptsTo(cleanup); } catch (error) { failures.push(error); }
    }
  }
  if (failures.length === 1) throw failures[0];
  if (failures.length > 1) throw new AggregateError(failures, 'Workspace preview failed; cleanup errors retain the original failure');
});

test('真实拖入 PNG 并发送，消息保留原文与图片且不泄露附件托管路径', async ({ actor }) => {
  await actor.attemptsTo(
    EnterChat(),
    StartOpenClawDraft(),
    AttachPng(),
    Ensure.that(PngIsReady(), equals(true)),
    Ensure.that(ChatBodyText(), not(includes('stagedPath'))),
    Ensure.that(ChatBodyText(), not(includes('attachment-staging'))),
    SendImageMessage(),
    Ensure.that(SessionErrorCount(), equals(0)),
    Ensure.that(SentUserText(), equals('Describe this image.')),
    Ensure.eventually(SentImageIsVisible(), equals(true)).timeoutAfter(Duration.ofSeconds(15)),
    Ensure.that(SentImageSource(), matches(/^(blob:|data:image\/png;base64,)/)),
    CheckSentImage(),
    Ensure.that(SentImageIsDecoded(), equals(true)),
    Ensure.that(ChatBodyText(), not(includes('stagedPath'))),
    Ensure.that(ChatBodyText(), not(includes('attachment-staging'))),
    Ensure.that(SentMessageText(), not(matches(/\[media attached|media:\/\/|\/api\/chat\/media\/|data:image|iVBORw0KGgo/i))),
    ReloadPngSession(),
    Ensure.that(SessionErrorCount(), equals(0)),
    Ensure.that(SentUserText(), equals('Describe this image.')),
    Ensure.that(SentImageIsVisible(), equals(true)),
    Ensure.that(SentImageIsDecoded(), equals(true)),
    Ensure.that(SentImageSource(), matches(/^data:image\/png;base64,/)),
    Ensure.that(ChatBodyText(), not(includes('stagedPath'))),
    Ensure.that(ChatBodyText(), not(includes('attachment-staging'))),
    Ensure.that(SentMessageText(), not(matches(/\[media attached|media:\/\/|\/api\/chat\/media\/|data:image|iVBORw0KGgo/i))),
  );
});
