import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';

import type { TeamGraphDefinition, TeamGraphEdgeDefinition, TeamGraphNodeDefinition } from './definition';

export type TeamGraphYamlExport = {
  readonly fileName: string;
  readonly yaml: string;
};

export function parseTeamGraphDefinitionYaml(yaml: string): Record<string, unknown> {
  let document: unknown;
  try {
    document = parseYaml(yaml);
  } catch (error) {
    throw new Error(`Invalid TeamRun graph YAML: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (!document || typeof document !== 'object' || Array.isArray(document)) {
    throw new Error('TeamRun graph YAML must contain a mapping document.');
  }
  const record = document as Record<string, unknown>;
  return removeUndefinedProperties({
    graphId: readString(record.graphId),
    runId: readString(record.runId),
    workflowPlanId: readString(record.workflowPlanId),
    title: readString(record.title),
    status: readString(record.status),
    nodes: readArray(record.nodes).map(normalizeTeamGraphYamlNode),
    edges: readArray(record.edges).map(normalizeTeamGraphYamlEdge),
    metadata: readRecordOrUndefined(record.metadata),
  });
}

export function exportTeamGraphDefinitionYaml(definition: TeamGraphDefinition): TeamGraphYamlExport {
  return {
    fileName: buildTeamGraphYamlFileName(definition),
    yaml: stringifyYaml(buildTeamGraphYamlDocument(definition), {
      indent: 2,
      lineWidth: 0,
      sortMapEntries: false,
    }),
  };
}

function buildTeamGraphYamlDocument(definition: TeamGraphDefinition): Record<string, unknown> {
  return removeUndefinedProperties({
    version: 1,
    graphId: definition.graphId,
    runId: definition.runId,
    workflowPlanId: definition.workflowPlanId,
    title: definition.title,
    status: definition.status,
    nodes: definition.nodes.map(buildTeamGraphYamlNode),
    edges: definition.edges.map(buildTeamGraphYamlEdge),
    metadata: nonEmptyRecord(definition.metadata),
  });
}

function buildTeamGraphYamlNode(node: TeamGraphNodeDefinition): Record<string, unknown> {
  return removeUndefinedProperties({
    id: node.nodeId,
    kind: node.kind,
    title: node.title,
    roleId: node.roleId,
    taskId: node.taskId,
    groupId: node.groupId,
    executor: nonEmptyRecord(node.executor),
    config: nonEmptyRecord(node.config),
    metadata: nonEmptyRecord(node.metadata),
  });
}

function buildTeamGraphYamlEdge(edge: TeamGraphEdgeDefinition): Record<string, unknown> {
  const { label, ...metadata } = edge.metadata;
  return removeUndefinedProperties({
    id: edge.edgeId,
    from: edge.sourceNodeId,
    to: edge.targetNodeId,
    sourcePort: edge.sourcePort,
    targetPort: edge.targetPort,
    edgeType: edge.type,
    kind: edge.kind,
    action: edge.action,
    payload: edge.payload,
    label: typeof label === 'string' && label.trim() ? label : undefined,
    metadata: nonEmptyRecord(metadata),
  });
}

function normalizeTeamGraphYamlNode(value: unknown): Record<string, unknown> {
  const record = readRecord(value);
  return removeUndefinedProperties({
    nodeId: readString(record.nodeId) ?? readString(record.id),
    kind: readString(record.kind),
    title: readString(record.title),
    roleId: readString(record.roleId),
    taskId: readString(record.taskId),
    groupId: readString(record.groupId),
    executor: readRecordOrUndefined(record.executor),
    config: readRecordOrUndefined(record.config),
    metadata: readRecordOrUndefined(record.metadata),
  });
}

function normalizeTeamGraphYamlEdge(value: unknown): Record<string, unknown> {
  const record = readRecord(value);
  return removeUndefinedProperties({
    edgeId: readString(record.edgeId) ?? readString(record.id),
    sourceNodeId: readString(record.sourceNodeId) ?? readString(record.fromNodeId) ?? readString(record.from),
    targetNodeId: readString(record.targetNodeId) ?? readString(record.toNodeId) ?? readString(record.to),
    sourcePort: readString(record.sourcePort),
    targetPort: readString(record.targetPort),
    edgeType: readString(record.edgeType),
    type: readString(record.type),
    kind: readString(record.kind),
    action: readString(record.action),
    payload: readRecordOrUndefined(record.payload),
    label: readString(record.label),
    metadata: readRecordOrUndefined(record.metadata),
  });
}

function nonEmptyRecord(value: Record<string, unknown> | undefined): Record<string, unknown> | undefined {
  if (!value || Object.keys(value).length === 0) return undefined;
  return value;
}

function removeUndefinedProperties(input: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(input).filter(([, value]) => value !== undefined));
}

function readRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function readRecordOrUndefined(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function readArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function readString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function buildTeamGraphYamlFileName(definition: TeamGraphDefinition): string {
  const rawName = definition.title || definition.graphId || definition.runId || 'team-run-graph';
  const baseName = rawName
    .trim()
    .replace(/[\\/:*?"<>|\x00-\x1F]+/g, '-')
    .replace(/^\.+/, '')
    .replace(/\.ya?ml$/i, '')
    .replace(/[.\s-]+$/g, '') || 'team-run-graph';
  return `${baseName}.yaml`;
}
