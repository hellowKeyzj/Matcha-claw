import { Ability } from '@serenity-js/core';
import { randomUUID } from 'node:crypto';
import { UseElectron, type PublicHostApiReply } from './use-electron.ability.js';

const openClawEndpoint = { kind: 'native-runtime', runtimeAdapterId: 'openclaw', runtimeInstanceId: 'local' } as const;
const nativeEndpoint = { kind: 'native-runtime', runtimeAdapterId: 'matcha-agent', runtimeInstanceId: 'local' } as const;
const forbiddenPublicKey = /^(?:sourcePath|sourceDir|configDir|workspaceDir|skillsDir|configPath|token|secret|session)$/i;
type Roster = { success: true; defaultId: string; agents: { id: string; name?: string }[] };
type SkillView = {
  agentId: string; support: { supportType: string; reason?: string }; selectionMode: string;
  explicitSkillKeys: string[]; options: { skillKey: string; displayName: string; selectable: boolean }[];
};
type ToolView = {
  agentId: string; support: { supportType: string }; selectionMode: string;
  toolPolicy: { profile: string; allow: string[]; deny: string[] } | null;
  toolProfiles: { profileKey: string }[];
};

function isPublic(value: unknown): boolean {
  if (Array.isArray(value)) return value.every(isPublic);
  if (!value || typeof value !== 'object') return true;
  return Object.entries(value).every(([key, child]) => !forbiddenPublicKey.test(key) && isPublic(child));
}

function responseBody(reply: PublicHostApiReply, status: number, operation: string): unknown {
  if (!isPublic(reply)) throw new Error(`${operation} exposed a forbidden private field`);
  if (!reply.ok) throw new Error(`${operation} did not reach the public Host API: ${reply.error.code}`);
  if (reply.data.status !== status || reply.data.ok !== (status >= 200 && status < 300)) {
    throw new Error(`${operation} requires HTTP ${status}; received ${reply.data.status}. No unavailable branch was accepted.`);
  }
  return reply.data.json;
}

export class Subagents extends Ability {
  constructor(private readonly electron: UseElectron) { super(); }

  private async openClawRoster(): Promise<Roster> {
    const directory = responseBody(await this.electron.fetchHostApi({ path: '/api/runtime-endpoints/list', method: 'GET' }), 200, 'Runtime endpoint directory') as {
      endpoints: { endpointRef: { kind: string; runtimeAdapterId?: string; runtimeInstanceId?: string }; defaultAgentId: string }[];
    };
    const runtime = directory.endpoints.find(entry => entry.endpointRef.kind === 'native-runtime'
      && entry.endpointRef.runtimeAdapterId === 'openclaw' && entry.endpointRef.runtimeInstanceId === 'local');
    if (!runtime?.defaultAgentId) throw new Error('Slice17 requires the real local OpenClaw management Agent in the public runtime directory');
    return this.roster({ kind: 'agent', endpoint: openClawEndpoint, agentId: runtime.defaultAgentId }, { kind: 'agent', agentId: runtime.defaultAgentId });
  }

  private async roster(scope: unknown, target: unknown): Promise<Roster> {
    const endpoint = (scope as { endpoint: unknown }).endpoint;
    const roster = responseBody(await this.electron.fetchHostApi({ path: '/api/subagents/agents', method: 'POST', body: JSON.stringify({
      id: 'subagent.management', operationId: 'subagents.list', scope, target, input: { kind: 'list', endpoint },
    }) }), 200, 'Subagent roster') as Roster;
    if (roster.success !== true || !Array.isArray(roster.agents) || !roster.agents.some(agent => agent.id === roster.defaultId)) {
      throw new Error('Subagent roster must contain its real default Agent');
    }
    return roster;
  }

  async inspectOpenClawBoundary() {
    const roster = await this.openClawRoster();
    const missingId = `serenity-missing-${randomUUID()}`;
    if (roster.agents.some(agent => agent.id === missingId)) throw new Error('Missing-Agent probe identity collided with the real roster');
    const view = await this.configuration<SkillView>('skills', 'subagentSkills.get', missingId);
    return { ids: roster.agents.map(agent => agent.id), missingAgentId: view.agentId, requestedAgentId: missingId, support: view.support, redacted: true };
  }

  async inspectNativeAndInvalidRequest() {
    const roster = await this.roster({ kind: 'runtime-instance', endpoint: nativeEndpoint }, { kind: 'runtime-instance' });
    const rejected = responseBody(await this.electron.fetchHostApi({ path: '/api/subagents/agents', method: 'POST', body: '{}' }), 503, 'Invalid Subagent request');
    return { nativeRosterReady: true, defaultId: roster.defaultId, rejected, redacted: true };
  }

  async inspectDeletedRoute() {
    const reply = await this.electron.fetchHostApi({ path: '/api/subagents/list', method: 'POST', body: '{}' });
    if (!isPublic(reply) || /(?:[A-Za-z]:[\\/]|token|secret|configDir|workspaceDir|session)/i.test(JSON.stringify(reply))) {
      throw new Error('Deleted Subagent route exposed private details');
    }
    if (reply.ok) throw new Error('The deleted historical Subagent route became reachable');
    return { rejected: true, message: reply.error.message, redacted: true };
  }

  async inspectKnownTemplate() {
    const catalog = responseBody(await this.electron.fetchHostApi({ path: '/api/openclaw/subagent-templates', method: 'GET' }), 200, 'Subagent template catalog') as { templates: { id: string }[] };
    const knownId = catalog.templates[0]?.id;
    if (!knownId) throw new Error('Slice17 requires at least one real public Subagent template');
    const detail = responseBody(await this.electron.fetchHostApi({ path: `/api/openclaw/subagent-templates/${encodeURIComponent(knownId)}`, method: 'GET' }), 200, 'Known Subagent template detail');
    if (!detail || typeof detail !== 'object' || !('template' in detail)
      || !detail.template || typeof detail.template !== 'object' || !('id' in detail.template)
      || detail.template.id !== knownId) throw new Error('Known Subagent template detail must contain the same catalog template.id');
    return { knownId, detailId: detail.template.id, redacted: true };
  }

  async rememberRoster(): Promise<string[]> {
    return (await this.openClawRoster()).agents.map(agent => agent.id);
  }

  async findCreatedAgent(name: string, previousIds: string[]): Promise<string | undefined> {
    const matches = (await this.openClawRoster()).agents.filter(agent => agent.name === name);
    if (matches.length === 0) return undefined;
    if (matches.length !== 1 || previousIds.includes(matches[0].id)) throw new Error('Owned Subagent identity is ambiguous; refusing cleanup');
    return matches[0].id;
  }

  private async configuration<T>(kind: 'skills' | 'tools', operationId: string, agentId: string): Promise<T> {
    return responseBody(await this.electron.fetchHostApi({ path: '/api/capabilities/execute', method: 'POST', body: JSON.stringify({
      id: `subagent.${kind}`, operationId, scope: { kind: 'agent', endpoint: openClawEndpoint, agentId },
      target: { kind: 'subagent', subagentId: agentId }, input: { agentId },
    }) }), 200, `Subagent ${kind} configuration`) as T;
  }

  async inspectConfiguration(agentId: string) {
    const skills = await this.configuration<SkillView>('skills', 'subagentSkills.get', agentId);
    const tools = await this.configuration<ToolView>('tools', 'subagentTools.get', agentId);
    if (skills.agentId !== agentId || tools.agentId !== agentId) throw new Error('Public configuration returned another Agent identity');
    if (skills.support.supportType !== 'supported' || tools.support.supportType !== 'supported') {
      throw new Error('Slice17 requires real OpenClaw per-Agent skill and tool configuration support');
    }
    return {
      skillMode: skills.selectionMode, skillKeys: [...skills.explicitSkillKeys].sort(), toolMode: tools.selectionMode,
      toolPolicy: tools.toolPolicy, redacted: true,
    };
  }

  async chooseExistingSkill(agentId: string) {
    const skills = await this.configuration<SkillView>('skills', 'subagentSkills.get', agentId);
    const tools = await this.configuration<ToolView>('tools', 'subagentTools.get', agentId);
    const skill = skills.options.find(option => option.selectable && skills.options.filter(candidate => candidate.displayName === option.displayName).length === 1);
    if (!skill) throw new Error('Slice17 requires one already-installed selectable Skill in the public list; no Skill installation, plugin enablement or private Skill read was attempted');
    if (!tools.toolProfiles.some(profile => profile.profileKey === 'minimal')) throw new Error('Slice17 requires the public OpenClaw minimal tool profile');
    return { skillKey: skill.skillKey, skillName: skill.displayName };
  }

  async reloadProjection(): Promise<void> {
    await this.electron.page.reload({ waitUntil: 'domcontentloaded' });
  }
}
