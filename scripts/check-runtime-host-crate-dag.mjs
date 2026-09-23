#!/usr/bin/env node

import fs from 'node:fs'
import path from 'node:path'

const root = process.cwd()
const runtimeHostRoot = path.join(root, 'runtime-host')
const workspaceManifest = path.join(runtimeHostRoot, 'Cargo.toml')

function read(file) {
  return fs.readFileSync(file, 'utf8')
}

function normalize(file) {
  return file.split(path.sep).join('/')
}

function workspaceMembers() {
  const source = read(workspaceManifest)
  const membersBlock = source.match(/members\s*=\s*\[([\s\S]*?)\]/m)?.[1] ?? ''
  return [...membersBlock.matchAll(/"([^"]+)"/g)].map(match => match[1])
}

function packageName(manifest) {
  return read(manifest).match(/^name\s*=\s*"([^"]+)"/m)?.[1]
}

function pathDependencies(manifest) {
  const source = read(manifest)
  const deps = []
  for (const line of source.split(/\r?\n/)) {
    const pathMatch = line.match(/^([A-Za-z0-9_-]+)\s*=\s*\{[^}]*path\s*=\s*"([^"]+)"/)
    if (!pathMatch) continue
    deps.push({ key: pathMatch[1], relativePath: pathMatch[2], line })
  }
  return deps
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

const members = workspaceMembers()
const byPackage = new Map()
const byMember = new Map()

for (const member of members) {
  const manifest = path.join(runtimeHostRoot, member, 'Cargo.toml')
  const name = packageName(manifest)
  if (!name) throw new Error(`missing package name: ${manifest}`)
  const crate = { member, name, manifest, layer: layer(member) }
  byPackage.set(name, crate)
  byMember.set(normalize(path.resolve(runtimeHostRoot, member)), crate)
}

function resolvePathDependency(from, dependency) {
  const absolute = normalize(path.resolve(path.dirname(from.manifest), dependency.relativePath))
  return byMember.get(absolute) ?? byPackage.get(dependency.key)
}

function isAllowed(from, to) {
  if (!to) return true
  if (from.layer === 'host') return true
  if (from.layer === 'foundation') return false
  if (from.layer === 'platform') return ['foundation'].includes(to.layer)
  if (from.layer === 'external') return ['foundation', 'platform'].includes(to.layer)
  if (from.layer === 'integration') return ['foundation', 'platform', 'module', 'external'].includes(to.layer)
  if (from.layer === 'module') return ['foundation', 'platform', 'module', 'external'].includes(to.layer)
  return false
}

const violations = []

for (const from of byPackage.values()) {
  for (const dependency of pathDependencies(from.manifest)) {
    const to = resolvePathDependency(from, dependency)
    if (!to || isAllowed(from, to)) continue
    violations.push(`${from.name} (${from.member}) -> ${to.name} (${to.member}) via ${dependency.line.trim()}`)
  }
}

if (violations.length) {
  console.error('runtime-host crate DAG violations:')
  for (const violation of violations) console.error(`- ${violation}`)
  process.exit(1)
}

console.log('runtime-host crate DAG ok')
