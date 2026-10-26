import { Ability } from '@serenity-js/core';
import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import type { UseElectron } from './use-electron.ability.js';

type Publisher = { publisher: string; keyId: string; publicKey: number[]; allowProcess: boolean; allowNative: boolean };
type Policy = { revision: string; trustedNativeDigests: string[]; trustedProcessDigests: string[]; trustedPublishers: Publisher[]; unsignedWasm: string };
const world = { tenantId: 'local', worldId: 'personal' };
// RFC 8032 public test vector only; no private key is generated or used.
const publicKey = 'd75a980182b10ab7d54bfed3c964073a0ee172f3daa62325af021a68f707511a';
const invalidKey = /^(请输入恰好 64 位小写十六进制的 Ed25519 公钥（32 字节），不要输入私钥。|Enter exactly 64 lowercase hexadecimal characters for a 32-byte Ed25519 public key, never a private key\.)$/;
const duplicateKey = /^(此发布者与密钥 ID 已在草稿中；如需替换，请先移除原条目。|This publisher and key ID are already in the draft\. Remove the original entry before replacing it\.)$/;
const displayed = (policy: Policy) => ({ ...policy, trustedPublishers: policy.trustedPublishers.map(root => ({ ...root, publicKey: Buffer.from(root.publicKey).toString('hex') })) });
function exact(actual: unknown, expected: unknown, label: string): void {
  if (!isDeepStrictEqual(actual, expected)) throw new Error(`World package trust ${label} differs; no trust mutation is authorized`);
}

export class WorldPackageTrust extends Ability {
  private baseline!: Policy;
  private root!: Publisher;
  constructor(private readonly electron: UseElectron) { super(); }
  private get workspace() { return this.electron.page.locator('main .world-workspace'); }
  private get panel() { return this.workspace.locator('details').filter({ has: this.electron.page.locator(':scope > summary').filter({ hasText: /^(当前包信任策略|Current package trust policy)$/ }) }); }
  private get publishers() { return this.panel.locator('section').filter({ has: this.electron.page.getByRole('heading', { name: /^(发布者签名信任根 · 草稿|Publisher signing trust roots — draft)$/, exact: true }) }); }
  private get before() { return this.panel.getByLabel(/^(替换前完整策略|Complete policy before replacement)$/, { exact: true }); }
  private get after() { return this.panel.getByLabel(/^(替换后完整策略|Complete policy after replacement)$/, { exact: true }); }
  private get submit() { return this.panel.getByRole('button', { name: /^(确认并提交信任变更|Confirm and submit trust changes)$/, exact: true }); }

  private async policy(): Promise<Policy> {
    const reply = await this.electron.fetchHostApi({ path: '/api/world/query', method: 'POST', timeoutMs: 10_000,
      body: { world, query: { kind: 'package_trust_policy', request: {} } } });
    if (!reply.ok) throw new Error(`World package trust read: transport=${reply.error.code}; no replay`);
    const body = reply.data.json as { success: boolean; data?: { kind: string; result: Policy }; error?: { code: string; stage: string; diagnosticId: string } };
    if (!body?.success) throw new Error(`World package trust read: HTTP ${reply.data.status}; code=${body?.error?.code}; stage=${body?.error?.stage}; diagnosticId=${body?.error?.diagnosticId}`);
    if (!reply.data.ok || reply.data.status !== 200 || body.data?.kind !== 'package_trust_policy') throw new Error('World package trust read returned a mismatched public envelope');
    return body.data.result;
  }
  private async readSurface(): Promise<void> {
    await this.workspace.getByRole('tab', { name: /^(能力扩展|Capabilities)$/, exact: true }).click();
    if (await this.panel.getAttribute('open') === null) await this.panel.locator(':scope > summary').click();
    await this.panel.getByRole('button', { name: /^(读取当前策略|Read current policy)$/, exact: true }).click();
    await this.panel.locator('fieldset').waitFor({ state: 'visible', timeout: 15_000 });
    await this.publishers.locator('form').waitFor({ state: 'visible', timeout: 15_000 });
  }
  private async flags() {
    return Promise.all([
      this.publishers.getByRole('checkbox', { name: /^(允许此密钥签名的进程包（不限摘要）|Allow process packages signed by this key \(any digest\))$/, exact: true }).isChecked(),
      this.publishers.getByRole('checkbox', { name: /^(允许此密钥签名的原生包（不限摘要）|Allow native packages signed by this key \(any digest\))$/, exact: true }).isChecked(),
    ]);
  }
  private async inspectDraft(added: boolean) {
    const expected = displayed({ ...this.baseline, trustedPublishers: [...this.baseline.trustedPublishers, ...(added ? [this.root] : [])] }).trustedPublishers;
    const roots = await this.publishers.locator(':scope > ul > li > dl').evaluateAll(elements => elements.map(root => Object.fromEntries(
      Array.from(root.children).map(row => [row.querySelector(':scope > dt')!.textContent!.trim(), row.querySelector(':scope > dd')!.textContent!.trim()]),
    )));
    exact(roots, expected.map(root => Object.fromEntries(Object.entries(root).map(([key, value]) => [key, String(value)]))), 'complete draft roots including public key, identity and flags');
    const flags = await this.flags(); exact(flags, [false, false], 'default flags');
    const previewCount = await this.before.count() + await this.after.count();
    exact(previewCount, added ? 2 : 0, 'complete preview count');
    const canSubmit = await this.submit.isEnabled(); exact(canSubmit, added, 'draft-only submit gate');
    if (added) {
      exact(JSON.parse(await this.before.innerText()), displayed(this.baseline), 'complete before preview');
      exact(JSON.parse(await this.after.innerText()), displayed({ ...this.baseline, revision: String(BigInt(this.baseline.revision) + 1n), trustedPublishers: [...this.baseline.trustedPublishers, this.root] }), 'complete after preview');
    }
    return { roots: roots.length, ownRoots: roots.filter(root => root.publisher === this.root.publisher && root.keyId === this.root.keyId).length,
      flags, previewCount, canSubmit, fullPreview: added };
  }
  private async enter(key: string): Promise<void> {
    await this.publishers.getByRole('textbox', { name: /^(发布者 ID|Publisher ID)$/, exact: true }).fill(this.root.publisher);
    await this.publishers.getByRole('textbox', { name: /^(密钥 ID|Key ID)$/, exact: true }).fill(this.root.keyId);
    await this.publishers.getByRole('textbox', { name: /^(Ed25519 公钥（64 位小写十六进制）|Ed25519 public key \(64 lowercase hexadecimal characters\))$/, exact: true }).fill(key);
    exact(await this.flags(), [false, false], 'flags before adding a public draft');
    await this.publishers.getByRole('button', { name: /^(将公钥加入草稿|Add public key to draft)$/, exact: true }).click();
  }
  async capture() {
    await this.readSurface();
    this.baseline = await this.policy();
    if (!/^[1-9]\d*$/.test(this.baseline.revision) || BigInt(this.baseline.revision) >= 9_223_372_036_854_775_807n
      || !Array.isArray(this.baseline.trustedPublishers) || this.baseline.trustedPublishers.length >= 4096) throw new Error('World trust policy has no available draft/revision capacity; no root is changed');
    this.root = { publisher: 'e2e-draft-only', keyId: `e2e-draft-only-${randomUUID()}`, publicKey: Array.from(Buffer.from(publicKey, 'hex')), allowProcess: false, allowNative: false };
    if (this.baseline.trustedPublishers.some(root => root.publisher === this.root.publisher && root.keyId === this.root.keyId)) throw new Error('One-time draft identity already exists; no retry');
    await this.inspectDraft(false);
    exact(await this.electron.page.getByRole('dialog').count(), 0, 'initial confirmation boundary');
    return { policy: this.baseline, publisher: this.root.publisher, keyId: this.root.keyId, publicKey };
  }
  async rejectInvalid() {
    const rejected: string[] = [];
    for (const key of [`${publicKey.slice(0, -1)}g`, publicKey.slice(0, -2), `${publicKey}00`]) {
      await this.enter(key);
      const alert = this.panel.getByRole('alert'); await alert.waitFor({ state: 'visible', timeout: 15_000 });
      exact(invalidKey.test(await alert.innerText()), true, 'hex/length rejection');
      await this.inspectDraft(false); rejected.push(key);
    }
    return { invalidHex: rejected[0].length === 64, short: rejected[1].length === 62, long: rejected[2].length === 66, noDraft: true };
  }
  async addDraft() {
    await this.enter(publicKey);
    exact(await this.panel.getByRole('alert').count(), 0, 'legal public key');
    return this.inspectDraft(true);
  }
  async rejectDuplicate() {
    await this.enter(publicKey);
    const alert = this.panel.getByRole('alert'); await alert.waitFor({ state: 'visible', timeout: 15_000 });
    exact(duplicateKey.test(await alert.innerText()), true, 'duplicate publisher plus key ID rejection');
    return this.inspectDraft(true);
  }
  async removeDraft() {
    const name = this.root;
    await this.publishers.getByRole('button', { name: new RegExp(`^(移除发布者 ${name.publisher} 的密钥 ${name.keyId}|Remove key ${name.keyId} for publisher ${name.publisher})$`), exact: true }).click();
    return this.inspectDraft(false);
  }
  async reviewAndCancel() {
    const dialog = this.electron.page.getByRole('dialog');
    exact(await dialog.count(), 0, 'confirmation before preview');
    // This opens the application dialog only. The final Confirm is never selected or clicked.
    await this.submit.click();
    try {
      await dialog.waitFor({ state: 'visible', timeout: 15_000 });
      const message = await dialog.innerText();
      const risks = [
        /本 World 的签名信任根|signing trust roots? (?:for|of) this World/i.test(message),
        /不是官方背书|not (?:an )?official endorsement/i.test(message),
        /不是密钥与摘要配对限定|do not restrict trust to a key-and-digest pair/i.test(message),
      ];
      exact(risks, [true, true, true], 'World root, non-official and non-key-plus-digest warnings');
      exact(message.includes('personal') && message.includes(`${this.baseline.revision} → ${String(BigInt(this.baseline.revision) + 1n)}`), true, 'confirmation World and revision');
      return { risks, draft: await this.inspectDraft(true) };
    } finally {
      await dialog.getByRole('button', { name: /^(取消|Cancel)$/, exact: true }).click();
      await dialog.waitFor({ state: 'detached', timeout: 15_000 });
      exact(await dialog.count(), 0, 'cancelled dialog collection');
    }
  }
  async afterCancel() {
    exact(await this.electron.page.getByRole('dialog').count(), 0, 'cancelled confirmation');
    return { policy: await this.policy(), draft: await this.inspectDraft(true) };
  }
  async afterRefresh() {
    await this.readSurface();
    return { policy: await this.policy(), draft: await this.inspectDraft(false) };
  }
}
