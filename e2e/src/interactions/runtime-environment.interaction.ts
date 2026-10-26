import { Interaction, notes } from '@serenity-js/core';
import { UseElectron } from '../abilities/use-electron.ability.js';

const missingTemplateId = 'e2e-runtime-environment-missing-template';

function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function hasPrivateRuntimeFields(value: unknown): boolean {
  if (Array.isArray(value)) return value.some(hasPrivateRuntimeFields);
  if (value === null || typeof value !== 'object') return false;
  return Object.entries(value).some(([key, child]) =>
    /^(?:sourcePath|sourceDir|configDir|workspaceDir|skillsDir|configPath|token|secret)$/i.test(key)
    || hasPrivateRuntimeFields(child));
}

export const ReadPublicRuntimeEnvironment = () => Interaction.where('#actor reads the public OpenClaw environment projection', async actor => {
  const reply = await actor.abilityTo(UseElectron).fetchHostApi({ path: '/api/openclaw/status', method: 'GET' });
  const body = record(reply.ok ? reply.data.json : undefined);
  const receipt = {
    ipcOk: reply.ok, status: reply.ok ? reply.data.status : null, httpOk: reply.ok && reply.data.ok,
    hasPackageExistsBoolean: typeof body.packageExists === 'boolean',
    hasIsBuiltBoolean: typeof body.isBuilt === 'boolean',
    hasPrivateRuntimeFields: hasPrivateRuntimeFields(reply),
  };
  await notes<{ runtimeEnvironmentStatus: typeof receipt }>().set('runtimeEnvironmentStatus', receipt).performAs(actor);
});

export const ReadNativeTemplateCatalogBoundary = () => Interaction.where('#actor reads the native template catalog without private runtime fields', async actor => {
  const reply = await actor.abilityTo(UseElectron).fetchHostApi({ path: '/api/openclaw/subagent-templates', method: 'GET' });
  const body = record(reply.ok ? reply.data.json : undefined);
  const receipt = {
    ipcOk: reply.ok, status: reply.ok ? reply.data.status : null, httpOk: reply.ok && reply.data.ok,
    hasCategoriesArray: Array.isArray(body.categories), hasTemplatesArray: Array.isArray(body.templates),
    missingTemplateIsAbsent: Array.isArray(body.templates) && body.templates.every(template => record(template).id !== missingTemplateId),
    hasPrivateRuntimeFields: hasPrivateRuntimeFields(reply),
  };
  await notes<{ runtimeEnvironmentTemplates: typeof receipt }>().set('runtimeEnvironmentTemplates', receipt).performAs(actor);
});

export const RequestUnknownNativeTemplate = () => Interaction.where('#actor requests a template absent from the native catalog', async actor => {
  const reply = await actor.abilityTo(UseElectron).fetchHostApi({
    path: `/api/openclaw/subagent-templates/${missingTemplateId}`, method: 'GET',
  });
  const body = record(reply.ok ? reply.data.json : undefined);
  const receipt = {
    ipcOk: reply.ok, status: reply.ok ? reply.data.status : null, httpOk: reply.ok && reply.data.ok,
    successIsFalse: body.success === false,
    hasFixedPublicError: body.error === 'OpenClaw subagent template is unavailable',
    hasTemplate: Object.prototype.hasOwnProperty.call(body, 'template'),
    hasPrivateRuntimeFields: hasPrivateRuntimeFields(reply),
  };
  await notes<{ runtimeEnvironmentMissingTemplate: typeof receipt }>().set('runtimeEnvironmentMissingTemplate', receipt).performAs(actor);
});

export const ComparePublicPackageReadiness = () => Interaction.where('#actor compares public package readiness with its environment source', async actor => {
  const electron = actor.abilityTo(UseElectron);
  const environment = await electron.fetchHostApi({ path: '/api/openclaw/status', method: 'GET' });
  const reply = await electron.fetchHostApi({ path: '/api/openclaw/ready', method: 'GET' });
  const status = record(environment.ok ? environment.data.json : undefined);
  const value = reply.ok ? reply.data.json : undefined;
  const receipt = {
    ipcOk: reply.ok, status: reply.ok ? reply.data.status : null, httpOk: reply.ok && reply.data.ok,
    environmentIsAvailable: environment.ok && environment.data.status === 200 && environment.data.ok,
    hasBooleanValue: typeof value === 'boolean',
    matchesPackageExists: typeof status.packageExists === 'boolean' && value === status.packageExists,
    hasPrivateRuntimeFields: hasPrivateRuntimeFields(reply),
  };
  await notes<{ runtimeEnvironmentReadiness: typeof receipt }>().set('runtimeEnvironmentReadiness', receipt).performAs(actor);
});
