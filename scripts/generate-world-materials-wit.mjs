import { readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';

const [source] = process.argv.slice(2);
if (!source || process.argv.length !== 3) throw new Error('Usage: node scripts/generate-world-materials-wit.mjs <world-materials-schema.json>');
const bytes = await readFile(source);
const api = JSON.parse(bytes);
if (api.format !== 'matcha.world-materials-api/1' || api.contract?.id !== 'world.materials.v1'
  || api.contract.version !== '1.0.0' || !/^sha256:[a-f0-9]{64}$/.test(api.contract.schemaDigest)
  || !api.method?.$defs || !api.request || !api.result) throw new Error('Invalid canonical materials schema export');
const destination = new URL('../runtime-host/modules/world/protocol/wit/world.wit', import.meta.url);
const wit = await readFile(destination, 'utf8');
const begin = '    // BEGIN canonical materials worker types';
const end = '    // END canonical materials worker types';
const start = wit.indexOf(begin);
const finish = wit.indexOf(end, start);
if (start < 0 || finish < start || wit.indexOf(begin, start + begin.length) >= 0) throw new Error('Missing unique materials WIT boundary');
const core = new Set([...wit.slice(0, start).matchAll(/\b(?:record|variant|enum|type)\s+([%a-z][a-z0-9%-]*)/g)].map(match => match[1].replace(/^%/, '')));
const definitions = api.method.$defs;
const declarations = new Map();
const visiting = new Set();
const keywords = new Set(['$schema', '$defs', '$ref', 'title', 'description', 'type', 'properties', 'required',
  'additionalProperties', 'items', 'oneOf', 'anyOf', 'enum', 'const', 'format', 'minimum', 'maximum', 'pattern']);
const reserved = new Set(['world', 'type', 'interface', 'record', 'list', 'stream', 'resource', 'from', 'result',
  'import', 'export', 'case', 'enum', 'variant', 'flags', 'own', 'borrow', 'tuple', 'option', 'future']);
const spelling = name => name.replace(/([a-z0-9])([A-Z])/g, '$1-$2').replace(/([A-Z])([A-Z][a-z])/g, '$1-$2')
  .replaceAll('_', '-').toLowerCase();
const identifier = name => {
  const value = spelling(name);
  if (!/^[a-z][a-z0-9]*(?:-[a-z][a-z0-9]*)*$/.test(value)) throw new Error(`Invalid WIT identifier ${name}`);
  return reserved.has(value) ? `%${value}` : value;
};
const typeNames = new Map([['ExpressionIr', 'expression'], ['CompileDiagnostic', 'diagnostic'],
  ['FailureKind', 'parser-diagnostic-kind']]);
const externalOptions = new Set(['ParseOptions', 'ImageOptions']);
const counters = new Set(['Revision', 'Generation', 'WriterEpoch', 'PolicyEpoch', 'GrantEpoch', 'PartitionEpoch', 'Sequence']);
// These fields use decimal-string serde or platform usize; their ABI is explicitly numeric.
const numeric = new Map([
  ['DocumentChunk.tokenEstimate', 'u64'], ['GenerationParameters.seed', 'u64'],
  ['GenerationParameters.maximumOutputTokens', 'u64'], ['ModelCapabilities.contextTokens', 'u64'],
  ['CoverageReason.image_limit.limit', 'u64'], ['ImageOptions.max_images', 'u64'],
  ['ImageOptions.full_page_min_text_chars', 'u64'],
]);
const contentFields = new Map([['MaterialRequest', 'input'], ['MaterialResponse', 'output'], ['DocumentCellValue', 'value']]);
function reference(schema) {
  if (typeof schema.$ref !== 'string' || !schema.$ref.startsWith('#/$defs/')) throw new Error('Only local schema references are supported');
  return schema.$ref.slice(8).replaceAll('~1', '/').replaceAll('~0', '~');
}
function check(schema, path) {
  if (!schema || typeof schema !== 'object' || Array.isArray(schema)) throw new Error(`Non-typed schema at ${path}`);
  for (const key of Object.keys(schema)) if (!keywords.has(key)) throw new Error(`Unsupported schema keyword ${key} at ${path}`);
}
function nullable(schema) {
  if (Array.isArray(schema.type) && schema.type.includes('null')) return { ...schema, type: schema.type.filter(type => type !== 'null')[0] };
  const alternatives = schema.anyOf ?? schema.oneOf;
  if (alternatives?.length === 2 && alternatives.some(item => item.type === 'null')) return alternatives.find(item => item.type !== 'null');
}
function named(name) {
  const schema = definitions[name];
  if (!schema) throw new Error(`Missing materials schema definition ${name}`);
  check(schema, name);
  if (counters.has(name)) return 'u64';
  const target = name === 'Definition' && schema.properties?.body?.$ref
    ? `definition-${spelling(reference(schema.properties.body))}` : typeNames.get(name) ?? spelling(name);
  if (core.has(target)) return target;
  if (schema.type === 'string' && !schema.enum) return 'string';
  if (declarations.has(target)) return target;
  if (visiting.has(target)) throw new Error(`Materials schema needs an explicit arena for ${name}`);
  visiting.add(target);
  declare(target, schema, name);
  visiting.delete(target);
  return target;
}
function type(schema, path, hint) {
  check(schema, path);
  const option = nullable(schema);
  if (option) return `option<${type(option, path, hint)}>`;
  if (numeric.has(path)) return numeric.get(path);
  if (schema.$ref) return named(reference(schema));
  switch (schema.type) {
    case 'string': if (!schema.enum) return 'string'; break;
    case 'boolean': return 'bool';
    case 'integer': {
      const formats = { uint8: 'u8', uint16: 'u16', uint32: 'u32', uint64: 'u64', int8: 's8', int16: 's16', int32: 's32', int64: 's64' };
      if (formats[schema.format]) return formats[schema.format];
      throw new Error(`Integer width is not frozen at ${path}`);
    }
    case 'number':
      if (schema.format === 'float') return 'f32';
      if (schema.format === 'double') return 'f64';
      throw new Error(`Float width is not frozen at ${path}`);
    case 'array': return `list<${type(schema.items, `${path}[]`, `${hint}-item`)}>`;
    case 'object':
      if (!schema.properties && schema.additionalProperties) return `list<tuple<string, ${type(schema.additionalProperties, `${path}.*`, `${hint}-value`)}>>`;
      break;
  }
  declare(hint, schema, path);
  return hint;
}
function fields(schema, path, hint) {
  const required = new Set(schema.required ?? []);
  const properties = Object.entries(schema.properties ?? {});
  if ((!externalOptions.has(path) && schema.additionalProperties !== false)
    || properties.some(([name, value]) => !required.has(name) && !nullable(value))) throw new Error(`Open or untyped optional record at ${path}`);
  return properties.map(([name, value]) => `${identifier(name)}: ${type(value, `${path}.${name}`, `${hint}-${spelling(name)}`)}`).join(', ');
}
function declare(name, schema, path) {
  if (declarations.has(name)) throw new Error(`Materials WIT name collision ${name}`);
  check(schema, path);
  if (schema.type === 'string' && schema.enum) {
    if (schema.enum.some(value => typeof value !== 'string')) throw new Error(`Non-string enum at ${path}`);
    declarations.set(name, `enum ${name} { ${schema.enum.map(identifier).join(', ')} }`);
    return;
  }
  if (schema.oneOf) {
    const discriminator = ['kind', 'method'].find(key => schema.oneOf.every(item => typeof item.properties?.[key]?.const === 'string'));
    if (!discriminator) throw new Error(`Untagged union at ${path}`);
    const cases = schema.oneOf.map(item => {
      check(item, path);
      const tag = item.properties[discriminator].const;
      const properties = { ...item.properties };
      delete properties[discriminator];
      const entries = Object.entries(properties);
      if (!entries.length) return identifier(tag);
      const caseName = `${name}-${spelling(tag)}`;
      const content = contentFields.get(path);
      const payload = content && entries.length === 1 && entries[0][0] === content
        ? type(entries[0][1], `${path}.${tag}`, caseName)
        : type({ ...item, properties, required: item.required.filter(key => key !== discriminator) }, `${path}.${tag}`, caseName);
      return `${identifier(tag)}(${payload})`;
    });
    declarations.set(name, `variant ${name} { ${cases.join(', ')} }`);
    return;
  }
  if (schema.type !== 'object') throw new Error(`Unsupported named materials type ${path}`);
  declarations.set(name, `record ${name} { ${fields(schema, path, name)} }`);
}
for (const [field, expected] of [['request', 'MaterialRequest'], ['response', 'MaterialResponse'], ['failure', 'WorkerFailure']]) {
  const schema = api.method.properties?.[field];
  if (!schema || reference(schema) !== expected) throw new Error(`Unexpected materials method ${field}`);
  named(expected);
}
const generated = [begin,
  `    // Source SHA-256: ${createHash('sha256').update(bytes).digest('hex')}`,
  `    // Contract: ${api.contract.id}@${api.contract.version} ${api.contract.schemaDigest}`,
  '    // Core arena types are shared; numeric wire projections require checked native conversion.',
  ...[...declarations].sort(([left], [right]) => left.localeCompare(right, 'en')).map(([, declaration]) => `    ${declaration}`),
  end,
].join('\n');
await writeFile(destination, wit.slice(0, start) + generated + wit.slice(finish + end.length));
console.log(`Generated ${declarations.size} materials WIT types from the canonical worker schema.`);
