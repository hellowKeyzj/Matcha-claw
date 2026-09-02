import { afterEach, describe, expect, test } from 'bun:test'
import { mkdirSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

// Test pure functions directly — no mock.module needed,
// so this test cannot pollute other tests in the same Bun process.
// See CLAUDE.md "Mock 使用规范" for why we avoid business-module mocking.
const { getBuiltinRipgrepCandidates, resolveBuiltinWithFallback } =
  await import('../ripgrep.js')

const tmpDir = join(tmpdir(), `ripgrep-config-test-${process.pid}`)
const archPlatform = 'x64-win32'
const binaryName = 'rg.exe'
const sourceVendorPath = join(
  tmpDir,
  'src',
  'utils',
  'vendor',
  'ripgrep',
  archPlatform,
  binaryName,
)
const distVendorPath = join(
  tmpDir,
  'dist',
  'vendor',
  'ripgrep',
  archPlatform,
  binaryName,
)
const legacyVendorPath = join(
  tmpDir,
  'vendor',
  'ripgrep',
  archPlatform,
  binaryName,
)

function writeFakeRipgrep(rgPath: string) {
  mkdirSync(join(rgPath, '..'), { recursive: true })
  writeFileSync(rgPath, '')
}

describe('getBuiltinRipgrepCandidates', () => {
  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true })
  })

  test('win32 x64 source vendor is a builtin candidate', () => {
    const candidates = getBuiltinRipgrepCandidates(tmpDir, 'x64', 'win32')

    expect(candidates).toEqual([
      distVendorPath,
      sourceVendorPath,
      legacyVendorPath,
    ])
  })

  test('dist root still resolves dist vendor under project root', () => {
    const candidates = getBuiltinRipgrepCandidates(
      join(tmpDir, 'dist'),
      'x64',
      'win32',
    )

    expect(candidates[0]).toBe(distVendorPath)
  })
})

describe('resolveBuiltinWithFallback', () => {
  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true })
  })

  test('source vendor exists -> mode=builtin', () => {
    writeFakeRipgrep(sourceVendorPath)

    const result = resolveBuiltinWithFallback(
      getBuiltinRipgrepCandidates(tmpDir, 'x64', 'win32'),
    )

    expect(result.mode).toBe('builtin')
    expect(result.command).toBe(sourceVendorPath)
    expect(result.note).toBeUndefined()
  })

  test('dist vendor exists -> mode=builtin before source vendor', () => {
    writeFakeRipgrep(sourceVendorPath)
    writeFakeRipgrep(distVendorPath)

    const result = resolveBuiltinWithFallback(
      getBuiltinRipgrepCandidates(tmpDir, 'x64', 'win32'),
    )

    expect(result.mode).toBe('builtin')
    expect(result.command).toBe(distVendorPath)
    expect(result.note).toBeUndefined()
  })

  test('legacy miss + system rg available -> mode=system', () => {
    const result = resolveBuiltinWithFallback(
      getBuiltinRipgrepCandidates(tmpDir, 'x64', 'win32'),
      '/usr/local/bin/rg',
      'testplatform',
    )

    expect(result.mode).toBe('system')
    expect(result.command).toBe('rg')
    expect(result.note).toContain('fallback')
    expect(result.note).toContain('testplatform')
  })

  test('no rg available -> most likely builtin path with note', () => {
    const result = resolveBuiltinWithFallback(
      getBuiltinRipgrepCandidates(tmpDir, 'x64', 'win32'),
      null,
      'testplatform',
    )

    expect(result.mode).toBe('builtin')
    expect(result.command).toBe(distVendorPath)
    expect(result.note).toContain('no ripgrep available')
    expect(result.note).toContain('testplatform')
  })
})
