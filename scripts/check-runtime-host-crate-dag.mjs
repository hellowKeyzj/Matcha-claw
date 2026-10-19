#!/usr/bin/env node

import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'

const runtimeHostRoot = path.join(process.cwd(), 'runtime-host')
const metadata = JSON.parse(execFileSync('cargo', [
  'metadata', '--offline', '--no-deps', '--format-version', '1',
  '--manifest-path', path.join(runtimeHostRoot, 'Cargo.toml'),
], { encoding: 'utf8', maxBuffer: 4 * 1024 * 1024, stdio: ['ignore', 'pipe', 'inherit'] }))

function normalize(file) {
  return file.replaceAll('\\', '/')
}

function directoryKey(directory) {
  return fs.realpathSync.native(directory)
}

function layer(member) {
  if (member === 'host') return 'host'
  if (member === 'foundation') return 'foundation'
  if (member === 'platform') return 'platform'
  if (member.startsWith('modules/')) return 'module'
  if (member.startsWith('integrations/')) return 'integration'
  if (member.startsWith('external/')) return 'external'
  return 'unknown'
}

// Compile-time public contracts, not ModuleDescriptor.requires. Runtime capability
// dependencies (including skills/subagents -> sealed stores) remain ModuleCatalog's DAG.
const moduleDependencies = new Map([
  // Fixed peer identity, capability surface and lifecycle language; no concrete driver.
  ['channels', ['runtime-directory']],
  ['cron', ['runtime-directory']],
  ['organization', ['runtime-directory']],
  ['platform-tools', ['runtime-directory']],
  ['search', ['runtime-directory']],
  ['plugins', ['runtime-directory']],
  ['skills', ['runtime-directory']],
  ['subagents', ['runtime-directory']],
  ['task-manager', ['runtime-directory']],
  ['workspace', ['runtime-directory']],
  // Provider private resolver consumes the Connector secret port, not its owner/store.
  ['provider', ['connectors', 'runtime-directory']],
  // Session secret ports, Team/role receipt identity and public Provider model-selection API.
  ['sessions', ['connectors', 'organization', 'provider', 'runtime-directory']],
  // Sealed store implementations consume Skills/Subagents port and projection contracts.
  ['sealed-resource', ['skills', 'subagents']],
])

const workspaceMembers = new Set(metadata.workspace_members)
const crates = metadata.packages.filter(crate => workspaceMembers.has(crate.id)).map(crate => {
  const directory = path.dirname(crate.manifest_path)
  const member = normalize(path.relative(metadata.workspace_root, directory))
  const library = crate.targets.find(target => target.kind.includes('lib') || target.kind.includes('proc-macro'))
  return { ...crate, directory, member, layer: layer(member), rustName: library?.name ?? crate.name.replaceAll('-', '_') }
})
const byDirectory = new Map(crates.map(crate => [directoryKey(crate.directory), crate]))
const violations = []
// Check every declared edge, including optional/target/dev/build dependencies;
// an inactive dependency must not bypass the architectural direction or cycle rules.
const edges = new Map(crates.map(crate => [crate.id, new Set()]))
const dependencies = new Map(crates.map(crate => [crate.id, []]))

function isAllowed(from, to) {
  if (from.layer === 'unknown' || to.layer === 'unknown') return false
  if (from.layer === 'host') return true
  if (from.layer === 'foundation') return false
  if (from.layer === 'platform') return to.layer === 'foundation'
  if (from.layer === 'external') return ['foundation', 'platform'].includes(to.layer)
  if (from.layer === 'integration') return ['foundation', 'platform', 'module', 'external'].includes(to.layer)
  if (from.layer === 'module' && to.layer === 'module') return moduleDependencies.get(from.name)?.includes(to.name) ?? false
  if (from.layer === 'module') return ['foundation', 'platform', 'external'].includes(to.layer)
  return false
}

for (const from of crates) {
  if (from.layer === 'unknown') violations.push(`${from.name}: unclassified workspace member ${from.member}`)
  for (const dependency of from.dependencies) {
    if (!dependency.path) continue
    const to = byDirectory.get(directoryKey(dependency.path))
    const via = `${dependency.rename ?? dependency.name} (${dependency.kind ?? 'normal'}${dependency.target ? `, target ${dependency.target}` : ''}${dependency.optional ? ', optional' : ''})`
    if (!to) {
      const relative = path.relative(runtimeHostRoot, dependency.path)
      if (!path.isAbsolute(relative) && relative !== '..' && !relative.startsWith(`..${path.sep}`)) {
        violations.push(`${from.name} (${from.member}) -> non-workspace internal crate ${normalize(dependency.path)} via ${via}`)
      }
      continue
    }
    edges.get(from.id).add(to.id)
    dependencies.get(from.id).push({ to, rustName: dependency.rename?.replaceAll('-', '_') ?? to.rustName, kind: dependency.kind })
    if (!isAllowed(from, to)) violations.push(`${from.name} (${from.member}) -> ${to.name} (${to.member}) via ${via}`)
  }
}

const byId = new Map(crates.map(crate => [crate.id, crate]))
const visited = new Set()
const active = []
function checkCycles(id) {
  const cycleStart = active.indexOf(id)
  if (cycleStart !== -1) {
    violations.push(`internal crate cycle: ${[...active.slice(cycleStart), id].map(id => byId.get(id).name).join(' -> ')}`)
    return
  }
  if (visited.has(id)) return
  active.push(id)
  for (const dependency of edges.get(id)) checkCycles(dependency)
  active.pop()
  visited.add(id)
}
for (const crate of crates) checkCycles(crate.id)

function rustSources(directory) {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    const file = path.join(directory, entry.name)
    if (entry.isDirectory()) return entry.name === 'tests' ? [] : rustSources(file)
    return entry.name.endsWith('.rs') && !entry.name.endsWith('tests.rs') ? [file] : []
  })
}

// ponytail: lexical use/path guard, not Rust name resolution or macro expansion.
// Flatten use trees so grouped imports, aliases and pub use cannot hide the same path.
function usePaths(source) {
  const imports = []
  for (const match of source.matchAll(/\buse\s+([^;]+);/g)) {
    const tokens = match[1].match(/(?:r#)?[A-Za-z_]\w*|::|[{},*]/g) ?? []
    let index = 0
    function visit(prefix) {
      const segments = [...prefix]
      while (index < tokens.length && !['{', '}', ',', 'as'].includes(tokens[index])) {
        const token = tokens[index++]
        if (token !== '::') segments.push(token.replace(/^r#/, ''))
      }
      if (tokens[index] === '{') {
        index++
        while (index < tokens.length && tokens[index] !== '}') {
          visit(segments)
          if (tokens[index] === ',') index++
        }
        index++
        return
      }
      const alias = tokens[index] === 'as' ? (index++, tokens[index++]) : undefined
      if (segments.at(-1) === 'self') segments.pop()
      imports.push({ segments, alias: alias?.replace(/^r#/, '') ?? segments.at(-1) })
    }
    while (index < tokens.length) {
      visit([])
      if (tokens[index] === ',') index++
      else break
    }
  }
  return imports
}

function stripRustTrivia(source) {
  const tokens = /\b(?:br|cr|r)(#+)?"[\s\S]*?"\1|"(?:\\.|[^"\\])*"|'(?:\\(?:u\{[^}]*\}|x[0-9A-Fa-f]{2}|.)|[^'\\\r\n])'|\/\/[^\n]*|\/\*/g
  let stripped = ''
  let cursor = 0
  for (let match; (match = tokens.exec(source));) {
    if (match[0] === '/*') {
      const delimiters = /\/\*|\*\//g
      delimiters.lastIndex = tokens.lastIndex
      let depth = 1
      for (let delimiter; depth && (delimiter = delimiters.exec(source));) {
        depth += delimiter[0] === '/*' ? 1 : -1
      }
      tokens.lastIndex = depth ? source.length : delimiters.lastIndex
    }
    stripped += source.slice(cursor, match.index) + source.slice(match.index, tokens.lastIndex).replace(/[^\n]/g, ' ')
    cursor = tokens.lastIndex
  }
  return stripped + source.slice(cursor)
}

function productionSource(file) {
  let source = stripRustTrivia(fs.readFileSync(file, 'utf8'))
  for (const match of [...source.matchAll(/#\s*\[\s*cfg\s*\(\s*test\s*\)\s*\]\s*(?:pub(?:\([^)]*\))?\s+)?mod\s+\w+\s*\{/g)].reverse()) {
    let end = match.index + match[0].length
    let depth = 1
    while (end < source.length && depth) {
      if (source[end] === '{') depth++
      if (source[end] === '}') depth--
      end++
    }
    source = source.slice(0, match.index) + source.slice(match.index, end).replace(/[^\n]/g, ' ') + source.slice(end)
  }
  return source
}

function resolveImport(segments, aliases) {
  while (['crate', 'self', 'super'].includes(segments[0])) segments = segments.slice(1)
  const prefix = aliases.get(segments[0])
  return prefix ? [...prefix, ...segments.slice(1)] : undefined
}

function addImportAliases(aliases, imports) {
  let changed = true
  while (changed) {
    changed = false
    for (const { segments, alias } of imports) {
      if (!alias || alias === '*' || aliases.has(alias)) continue
      const resolved = resolveImport(segments, aliases)
      if (!resolved) continue
      aliases.set(alias, resolved)
      changed = true
    }
  }
}

const internalSegments = new Set(['owner', 'internal', 'application', 'store', 'domain'])
function checkSourceBoundaries(from) {
  const businessDependencies = dependencies.get(from.id).filter(({ to, kind }) => to.layer === 'module' && to.id !== from.id && kind == null)
  if (!businessDependencies.length) return
  const crateAliases = new Map(businessDependencies.map(({ to, rustName }) => [rustName, [to.name]]))
  const sources = rustSources(path.join(from.directory, 'src')).map(file => {
    const source = productionSource(file)
    const imports = [
      ...usePaths(source),
      ...[...source.matchAll(/\bextern\s+crate\s+((?:r#)?[A-Za-z_]\w*)\s+as\s+((?:r#)?[A-Za-z_]\w*)\s*;/g)]
        .map(match => ({ segments: [match[1].replace(/^r#/, '')], alias: match[2].replace(/^r#/, '') })),
    ]
    return { file, source, imports }
  })
  for (const { file, source, imports } of sources) {
    const aliases = new Map(crateAliases)
    addImportAliases(aliases, imports)
    const paths = [
      ...imports.map(({ segments }) => segments),
      ...[...source.matchAll(/\b(?:r#)?[A-Za-z_]\w*(?:\s*::\s*(?:r#)?[A-Za-z_]\w*)+/g)]
        .map(match => match[0].replaceAll('r#', '').split(/\s*::\s*/)),
    ]
    const forbidden = new Set(paths.map(segments => resolveImport(segments, aliases)).filter(segments => segments && internalSegments.has(segments[1])).map(segments => segments.join('::')))
    for (const imported of forbidden) violations.push(`${normalize(file)}: ${imported} (use the module's public API/ports, not internal layers)`)
  }
}
for (const crate of crates) {
  if (['host', 'module'].includes(crate.layer)) checkSourceBoundaries(crate)
}

if (violations.length) {
  console.error('runtime-host architecture violations:')
  for (const violation of violations) console.error(`- ${violation}`)
  process.exit(1)
}

console.log('runtime-host crate DAG and module boundaries ok')
