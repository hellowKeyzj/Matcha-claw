import { readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';

const source = new URL('../runtime-host/modules/world/protocol/world-api.schema.json', import.meta.url);
const destination = new URL('../src/types/world.ts', import.meta.url);
const bytes = await readFile(source);
const api = JSON.parse(bytes);
if (api.format !== 'matcha.world-public-api/1') throw new Error('Unsupported world schema format');

const keywords = new Set([
  '$schema', '$defs', '$ref', 'title', 'description', 'type', 'properties', 'required',
  'additionalProperties', 'items', 'oneOf', 'anyOf', 'allOf', 'enum', 'const',
  'format', 'minimum', 'maximum', 'pattern',
]);
const roots = new Map(Object.entries(api.schemas));
const definitions = new Map();
const identifier = /^[A-Za-z_$][\w$]*$/;
function references(schema) {
  if (typeof schema === 'boolean') return [];
  return [
    ...(schema.$ref ? [referenceName(schema.$ref)] : []),
    ...Object.values(schema.properties ?? {}).flatMap(references),
    ...['oneOf', 'anyOf', 'allOf'].flatMap(key => (schema[key] ?? []).flatMap(references)),
    ...(schema.items === undefined ? [] : references(schema.items)),
    ...(typeof schema.additionalProperties === 'object' ? references(schema.additionalProperties) : []),
  ];
}
function referenceName(reference) {
  if (!reference.startsWith('#/$defs/')) throw new Error(`Unsupported schema reference: ${reference}`);
  return reference.slice(8).replaceAll('~1', '/').replaceAll('~0', '~');
}
for (const [root, schema] of roots) {
  if (!identifier.test(root)) throw new Error(`Invalid root type name: ${root}`);
  for (const [name, definition] of Object.entries(schema.$defs ?? {})) {
    if (!identifier.test(name)) throw new Error(`Invalid definition name: ${name}`);
    const entries = definitions.get(name) ?? [];
    entries.push({ root, schema: definition });
    definitions.set(name, entries);
  }
}
// Schemars assigns local names to generic instantiations. Never merge unlike local definitions.
const local = new Set([...definitions].filter(([name, entries]) => roots.has(name)
  || new Set(entries.map(entry => JSON.stringify(entry.schema))).size > 1).map(([name]) => name));
let changed;
do {
  changed = false;
  for (const [name, entries] of definitions) {
    if (!local.has(name) && entries.some(entry => references(entry.schema).some(ref => local.has(ref)))) {
      local.add(name);
      changed = true;
    }
  }
} while (changed);
const definitionName = (root, name) => local.has(name) ? `${root}_${name}` : name;
function render(schema, root) {
  if (schema === true) return 'unknown';
  if (schema === false) return 'never';
  for (const key of Object.keys(schema)) {
    if (!keywords.has(key)) throw new Error(`Unsupported schema keyword ${key} in ${root}`);
  }
  const parts = [];
  if (schema.$ref) {
    const name = referenceName(schema.$ref);
    if (!Object.hasOwn(roots.get(root).$defs ?? {}, name)) throw new Error(`Missing ${root} reference ${name}`);
    parts.push(definitionName(root, name));
  }
  if (Object.hasOwn(schema, 'const')) parts.push(JSON.stringify(schema.const));
  else if (schema.enum) parts.push(schema.enum.map(value => JSON.stringify(value)).join(' | ') || 'never');
  else if (schema.type) {
    const types = Array.isArray(schema.type) ? schema.type : [schema.type];
    parts.push(types.map(type => {
      switch (type) {
        case 'null': return 'null';
        case 'string': return 'string';
        case 'boolean': return 'boolean';
        case 'integer': case 'number': return 'number';
        case 'array': {
          if (schema.items === undefined) throw new Error(`Array without items in ${root}`);
          return `Array<${render(schema.items, root)}>`;
        }
        case 'object': {
          const properties = schema.properties ?? {};
          const required = new Set(schema.required ?? []);
          for (const key of required) if (!Object.hasOwn(properties, key)) throw new Error(`Unknown required field ${root}.${key}`);
          const fields = Object.entries(properties).map(([key, value]) => `${JSON.stringify(key)}${required.has(key) ? '' : '?'}: ${render(value, root)};`);
          const extra = schema.additionalProperties;
          if (extra !== false) fields.push(`[key: string]: ${typeof extra === 'object' ? render(extra, root) : 'unknown'};`);
          return fields.length ? `{ ${fields.join(' ')} }` : 'Record<string, never>';
        }
        default: throw new Error(`Unsupported schema type ${type} in ${root}`);
      }
    }).join(' | '));
  }
  for (const key of ['oneOf', 'anyOf', 'allOf']) {
    if (schema[key]) parts.push(schema[key].map(value => `(${render(value, root)})`).join(key === 'allOf' ? ' & ' : ' | '));
  }
  if (!parts.length) {
    if (schema.properties || schema.items) throw new Error(`Schema without type in ${root}`);
    return 'unknown';
  }
  return parts.length === 1 ? parts[0] : parts.map(part => `(${part})`).join(' & ');
}
const declarations = new Map();
function declare(name, schema, root) {
  if (declarations.has(name)) throw new Error(`Generated type name collision: ${name}`);
  declarations.set(name, `export type ${name} = ${render(schema, root)};`);
}
for (const [name, entries] of definitions) {
  for (const entry of local.has(name) ? entries : entries.slice(0, 1)) {
    declare(definitionName(entry.root, name), entry.schema, entry.root);
  }
}
for (const [root, schema] of roots) declare(root, schema, root);
for (const route of ['query', 'command', 'operation', 'peer']) {
  const operations = api.operations[route];
  if (!operations || Object.values(operations).some(value => typeof value !== 'string')) throw new Error(`Invalid ${route} operations`);
}
if (!Array.isArray(api.sourceConnectors) || api.sourceConnectors.some(item => !item
  || typeof item.registration !== 'string' || typeof item.driver !== 'string'
  || !item.readContract || typeof item.readContract.id !== 'string'
  || typeof item.readContract.version !== 'string' || typeof item.readContract.schemaDigest !== 'string')) {
  throw new Error('Invalid canonical source connector catalog');
}
const output = [
  '// Generated by scripts/generate-world-types.mjs. Do not edit.',
  `// Source SHA-256: ${createHash('sha256').update(bytes).digest('hex')}`,
  '// Compile-time wire shapes only; schema bounds and authorization require runtime validation.',
  '',
  ...[...declarations].sort(([a], [b]) => a.localeCompare(b, 'en')).map(([, text]) => text),
  '',
  'export type WorldQueryEnvelope = QueryEnvelope;',
  'export type WorldCommandEnvelope = CommandEnvelope;',
  'export type WorldOperationRequest = OperationRequest;',
  'export type WorldPeerRequest = PeerRequest;',
  '',
  `export const WORLD_OPERATIONS = ${JSON.stringify(api.operations, null, 2)} as const;`,
  '',
  `export const WORLD_SOURCE_CONNECTORS = ${JSON.stringify(api.sourceConnectors, null, 2)} as const;`,
  '',
].join('\n');
await writeFile(destination, output);
console.log(`Generated ${declarations.size} world types from ${roots.size} canonical schemas.`);
