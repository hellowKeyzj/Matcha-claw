import { Interaction, notes } from '@serenity-js/core';
import { Attribute } from '@serenity-js/web';
import { UseElectron } from '../abilities/use-electron.ability.js';
import { UsageHistoryPage } from '../pages/usage-history.page.js';

export const ReadPublicDashboardUsage = () => Interaction.where('#actor reads the selected runtime usage through the public Dashboard contract', async actor => {
  const electron = actor.abilityTo(UseElectron);
  const selectedName = await actor.answer(Attribute.called('aria-label').of(UsageHistoryPage.selectedRuntime));
  const directory = await electron.fetchHostApi({ path: '/api/runtime-endpoints/list', method: 'GET' });
  if (!directory.ok || directory.data.status !== 200 || !directory.data.ok) {
    throw new Error('Public runtime endpoint directory must return HTTP 200 before reading Dashboard usage');
  }
  const payload = directory.data.json;
  if (!payload || typeof payload !== 'object' || !('endpoints' in payload) || !Array.isArray(payload.endpoints)) {
    throw new Error('Public runtime endpoint directory did not return endpoints');
  }
  const matches = payload.endpoints.filter((entry: unknown) => entry && typeof entry === 'object'
    && 'displayName' in entry && entry.displayName === selectedName);
  if (matches.length !== 1) throw new Error('Dashboard runtime selection must identify exactly one public endpoint');
  const runtime = matches[0] as {
    endpointRef?: { kind: string; runtimeAdapterId: string; runtimeInstanceId: string };
    lifecycle?: { ready?: boolean };
    controlState?: { readiness?: { ready?: boolean } };
    capabilityFamilies?: { family: string; availability: string }[];
  };
  const endpoint = runtime.endpointRef;
  if (!endpoint || endpoint.kind !== 'native-runtime' || !['openclaw', 'matcha-agent'].includes(endpoint.runtimeAdapterId)
    || typeof endpoint.runtimeInstanceId !== 'string' || !endpoint.runtimeInstanceId
    || runtime.lifecycle?.ready !== true || runtime.controlState?.readiness?.ready !== true
    || !runtime.capabilityFamilies?.some(entry => entry.family === 'usage' && entry.availability === 'supported')) {
    throw new Error('Dashboard requires a ready native runtime with supported usage capability; no model request was sent');
  }
  const scope = encodeURIComponent(JSON.stringify({ kind: 'runtime-instance', endpoint }));
  const reply = await electron.fetchHostApi({ path: `/api/runtime-host/usage/recent?scope=${scope}`, method: 'GET' });
  if (!reply.ok) throw new Error(`Public usage IPC failed: ${reply.error.code}`);
  if (reply.data.status !== 200 || !reply.data.ok) {
    throw new Error(`Public usage must return HTTP 200, received ${reply.data.status}; unavailability is not empty history`);
  }
  const entries = reply.data.json;
  if (!Array.isArray(entries)) throw new Error('Dashboard public usage projection must be an array, including for empty history');
  const required = ['sessionId', 'agentId', 'timestamp', 'inputTokens', 'outputTokens', 'cacheReadTokens', 'cacheWriteTokens', 'totalTokens'];
  const optional = ['model', 'provider', 'costUsd'];
  for (const entry of entries) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)
      || !required.every(key => Object.hasOwn(entry, key))
      || Object.keys(entry).some(key => !required.includes(key) && !optional.includes(key))
      || typeof entry.sessionId !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/.test(entry.sessionId)
      || /^.+\.checkpoint\.[0-9a-fA-F-]{36}$/.test(entry.sessionId)
      || typeof entry.agentId !== 'string' || !(endpoint.runtimeAdapterId === 'matcha-agent'
        ? /^[A-Za-z0-9_-]+$/ : /^[a-z0-9][a-z0-9_-]{0,63}$/).test(entry.agentId)
      || typeof entry.timestamp !== 'string' || !Number.isFinite(Date.parse(entry.timestamp))
      || !required.slice(3).every(key => Number.isSafeInteger(entry[key]) && entry[key] >= 0)
      || (entry.model !== undefined && typeof entry.model !== 'string')
      || (entry.provider !== undefined && typeof entry.provider !== 'string')
      || (entry.costUsd !== undefined && (typeof entry.costUsd !== 'number' || !Number.isFinite(entry.costUsd) || entry.costUsd < 0))) {
      throw new Error('Public usage entry violates the current safe public DTO; it cannot be treated as empty history');
    }
  }
  await notes().set('usageHistoryProjection', entries).performAs(actor);
});
