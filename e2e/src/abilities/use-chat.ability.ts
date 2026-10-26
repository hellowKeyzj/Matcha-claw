import { Ability } from '@serenity-js/core';
import { createHash, randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import type { UseElectron } from './use-electron.ability.js';

const TINY_PNG_BASE64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/iZk9HQAAAABJRU5ErkJggg==';

export class UseChat extends Ability {
  private workspaceAgent?: { name: string; previousIds: string[]; submitted: boolean; createdId?: string; deletionSubmitted?: boolean };
  private pngSessionBaseline?: string[];
  private pngSession?: string;

  prepareWorkspaceAgent(previousIds: string[]): string {
    if (this.workspaceAgent) throw new Error('Workspace Agent creation must not be retried');
    const name = `serenity-workspace-${randomUUID()}`;
    this.workspaceAgent = { name, previousIds, submitted: false };
    return name;
  }

  submitWorkspaceAgent(): void {
    if (!this.workspaceAgent || this.workspaceAgent.submitted) throw new Error('Workspace Agent creation must be submitted only once');
    this.workspaceAgent.submitted = true;
  }

  confirmWorkspaceAgent(id: string, name: string, title: string, moreLabel: string, chatLabel: string): string {
    const agent = this.workspaceAgent;
    if (!agent?.submitted || name !== agent.name || !id || id === 'main' || title !== id || agent.previousIds.includes(id)
      || ![`更多操作 ${id}`, `More actions ${id}`].includes(moreLabel)
      || ![`会话 ${id}`, `Chat ${id}`].includes(chatLabel)) {
      throw new Error('Workspace Agent creation was not confirmed; no retry or name-based cleanup is allowed');
    }
    agent.createdId = id;
    return id;
  }

  submitWorkspaceAgentDeletion(id: string): void {
    const agent = this.workspaceAgent;
    if (!agent?.createdId || agent.createdId !== id || agent.deletionSubmitted) {
      throw new Error('Only the confirmed Workspace Agent may be deleted, once');
    }
    agent.deletionSubmitted = true;
  }

  constructor(private readonly electron: UseElectron) {
    super();
  }

  async rememberPngSessionBaseline(): Promise<void> {
    if (this.pngSessionBaseline) throw new Error('The PNG session baseline must be captured before the only send');
    this.pngSessionBaseline = await this.electron.page.getByTestId('session-list-scroll-area')
      .locator('[data-testid^="session-avatar-"]').evaluateAll(elements => elements.map(element => element.getAttribute('data-testid')!));
  }

  async rememberPngSession(): Promise<string> {
    if (!this.pngSessionBaseline) throw new Error('The PNG send requires its original complete directory baseline');
    const avatars = this.electron.page.getByTestId('session-list-scroll-area').locator('[data-testid^="session-avatar-"]');
    const selected = await avatars.evaluateAll(elements => elements.filter(element => {
      const row = element.closest('button')?.parentElement;
      return row?.classList.contains('bg-secondary') && row.classList.contains('text-foreground');
    }).map(element => element.getAttribute('data-testid')!));
    if (selected.length !== 1) throw new Error('The sent PNG must belong to one confirmed current session');
    const identity = JSON.parse(selected[0].slice('session-avatar-'.length)) as {
      type?: string; endpoint?: { kind?: string; runtimeAdapterId?: string; runtimeInstanceId?: string }; agentId?: string; sessionKey?: string;
    };
    if (identity.type !== 'session-identity' || identity.endpoint?.kind !== 'native-runtime'
      || identity.endpoint.runtimeAdapterId !== 'openclaw' || identity.endpoint.runtimeInstanceId !== 'local'
      || identity.agentId !== 'main' || !identity.sessionKey) {
      throw new Error('The sent PNG session is not the selected local OpenClaw main Agent session');
    }
    if (this.pngSessionBaseline.includes(selected[0]) || (this.pngSession && this.pngSession !== selected[0])) {
      throw new Error('The PNG session must be new and retain its complete identity after the only send');
    }
    const sessionIdentity = {
      endpoint: { kind: identity.endpoint.kind, runtimeAdapterId: identity.endpoint.runtimeAdapterId, runtimeInstanceId: identity.endpoint.runtimeInstanceId },
      agentId: identity.agentId, sessionKey: identity.sessionKey,
    };
    const startedAt = Date.now();
    const persistenceDeadline = startedAt + 30_000;
    const diagnosticDeadline = startedAt + 130_000;
    let persistenceFailure = 'The only PNG send was not persisted in its exact identity before the readback deadline; never resend';
    do {
      const reply = await this.electron.fetchHostApi({ path: '/api/capabilities/execute', method: 'POST', timeoutMs: 8_000,
        body: { id: 'session.management', operationId: 'sessions.load', scope: { kind: 'session', identity: sessionIdentity },
          target: { kind: 'session', identity: sessionIdentity }, input: { sessionIdentity, sessionKey: identity.sessionKey, limit: 100 } } });
      if (!reply.ok || !reply.data.ok || reply.data.status !== 200) throw new Error('The new PNG session history could not be confirmed; never resend');
      type Runtime = { phase: string };
      const view = reply.data.json as { identity?: typeof sessionIdentity; sessionKey?: string;
        items?: { complete?: Array<{ kind: string; text?: string }>; incomplete?: { facts: Array<{ kind: string; text?: string }> } };
        runtime?: { complete?: Runtime; incomplete?: { facts: Runtime } } };
      const actual = view.identity;
      const items = view.items?.complete ?? view.items?.incomplete?.facts;
      if (actual?.sessionKey !== sessionIdentity.sessionKey || actual.agentId !== sessionIdentity.agentId
        || actual.endpoint.kind !== sessionIdentity.endpoint.kind || actual.endpoint.runtimeAdapterId !== sessionIdentity.endpoint.runtimeAdapterId
        || actual.endpoint.runtimeInstanceId !== sessionIdentity.endpoint.runtimeInstanceId || view.sessionKey !== sessionIdentity.sessionKey
        || !Array.isArray(items)) throw new Error('The PNG history crossed identity or did not contain real facts');
      const phase = (view.runtime?.complete ?? view.runtime?.incomplete?.facts)?.phase;
      if (phase === 'failed' || phase === 'cancelled') {
        persistenceFailure = 'The PNG run failed or was cancelled; never resend';
        break;
      }
      const count = items.filter(item => item.kind === 'userMessage' && item.text === 'Describe this image.').length;
      if (count > 1) throw new Error('The PNG session contains duplicate original user messages; never resend');
      if (count === 1) {
        if (Date.now() >= persistenceDeadline) break;
        this.pngSession = selected[0];
        return this.pngSession;
      }
      await delay(250);
    } while (Date.now() < diagnosticDeadline);
    const diagnostics = await this.electron.page.evaluate(async sessionHash => {
      const unavailable = { readOutcome: 'unavailable', stages: [] };
      try {
        const bridge = (window as unknown as { electron: { ipcRenderer: { invoke(channel: string, request: unknown): Promise<unknown> } } }).electron.ipcRenderer;
        const reply = await bridge.invoke('hostapi:fetch', {
          requestId: crypto.randomUUID(), path: '/api/openclaw/logs?tailLines=500', method: 'GET', timeoutMs: 8_000,
        }) as { ok?: boolean; data?: { ok?: boolean; status?: number; json?: { content?: string } } };
        if (reply?.ok !== true || reply.data?.ok !== true || reply.data.status !== 200
          || typeof reply.data.json?.content !== 'string') return unavailable;
        const pattern = /\[matcha-chat-stage\] runHash=(sha256:[0-9a-f]{12}|-) sessionHash=(sha256:[0-9a-f]{12}|-) stage=(ack_sent|dispatch_entered|inbound_entered|followup_deferred|followup_adopted|embedded_entered|lane_wait|lane_admitted|model_call_started|agent_started|agent_terminal|dispatch_returned|dispatch_failed|post_dispatch_completed|finalize_entered|finalize_completed|publication_import_entered|publication_import_returned|publication_entered|publication_replacement_wait|publication_owner_wait|publication_returned|admission_entered|admission_ticket_returned|admission_returned|inbound_claim_entered|inbound_claim_returned|before_dispatch_entered|before_dispatch_returned|reply_dispatch_entered|reply_dispatch_returned|resolver_import_entered|resolver_import_returned|workspace_entered|workspace_returned|remote_media_entered|remote_media_returned|media_understanding_entered|media_understanding_returned|session_init_entered|session_init_returned|prepared_reply_entered|prepared_reply_returned|agent_preflight_entered|compaction_entered|compaction_returned|user_commit_entered|user_commit_returned|projection_retry_entered|projection_retry_returned) elapsedMs=([0-9]{1,16}) state=(none|queued|inline|completed|failed|cancelled|unknown|client-retry|retry|reconcile|terminal) agentRunHash=(sha256:[0-9a-f]{12}|-)(?=$|[\s"\\}])/g;
        const stages = Array.from(reply.data.json.content.matchAll(pattern))
          .filter(match => match[2] === sessionHash && Number.isSafeInteger(Number(match[4])))
          .slice(-64).map(match => ({ runHash: match[1], sessionHash: match[2], stage: match[3],
            elapsedMs: Number(match[4]), state: match[5], agentRunHash: match[6] }));
        return { readOutcome: stages.length ? 'observed' : 'unknown', stages };
      } catch { return unavailable; }
    }, `sha256:${createHash('sha256').update(identity.sessionKey.trim()).digest('hex').slice(0, 12)}`)
      .catch(() => ({ readOutcome: 'unavailable', stages: [] }));
    throw new Error(`${persistenceFailure}; nativeStages=${JSON.stringify(diagnostics)}`);
  }

  async waitForSentImage(): Promise<boolean> {
    await this.electron.page.waitForFunction(() => {
      const rows = Array.from(document.querySelectorAll('[data-testid="chat-message-stack"] [data-chat-item-kind="user-message"]'))
        .filter(row => Array.from(row.querySelectorAll('p')).some(text => text.textContent === 'Describe this image.'));
      if (rows.length !== 1) return false;
      const images = rows[0].querySelectorAll<HTMLImageElement>('img:not([alt="user-avatar"])');
      return images.length === 1 && images[0].complete && images[0].naturalWidth > 0 && images[0].naturalHeight > 0
        && !rows[0].querySelector('[data-testid="chat-missing-image-preview"], [data-testid="chat-image-preview-unavailable"]');
    }, undefined, { timeout: 15_000 });
    return true;
  }

  async dropPng(): Promise<void> {
    await this.electron.page.getByTestId('chat-composer-input').evaluate((textarea, base64) => {
      const target = textarea.closest('[data-testid="chat-composer"]');
      if (!target) throw new Error('Chat composer drop target is missing');
      const bytes = Uint8Array.from(atob(base64), character => character.charCodeAt(0));
      const transfer = new DataTransfer();
      transfer.items.add(new File([bytes], 'e2e-attachment.png', { type: 'image/png' }));
      target.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: transfer }));
    }, TINY_PNG_BASE64);
  }
}
