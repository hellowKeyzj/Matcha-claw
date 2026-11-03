import { setTimeout as sleep } from 'node:timers/promises'
import type { BrowserUtilityRequest } from '../browser-action-contract.js'
import { checkSnapshotFailure, type NativeTransport } from './native-snapshot.js'

type ScriptRequest = Extract<BrowserUtilityRequest, { kind: 'scripts' }>
type SourceMapRequest = Extract<BrowserUtilityRequest, { kind: 'sourceMap' }>
type Script = {
  scriptId: string
  url: string
  length?: number
  hash?: string
  sourceMappingURL?: string
  source?: string
  beautified?: boolean
  sourceTruncated?: boolean
}
type ParsedScript = { script: Script; sessionId?: string }

export async function readScripts(request: ScriptRequest, transport: NativeTransport): Promise<Record<string, unknown>[]> {
  return (await inspectScripts(request, transport)).map(({ script }) => script)
}

async function inspectScripts(request: ScriptRequest, transport: NativeTransport): Promise<ParsedScript[]> {
  transport.assertCurrent()
  if (request.includeSource === true && !request.filter) throw new Error('includeSource requires a URL filter')
  const sessions = new Set<string | undefined>()
  const resumes = new Set<Promise<void>>()
  const failures: unknown[] = []
  const parsedScripts: ParsedScript[] = [], result: ParsedScript[] = []
  const stops: (() => void)[] = []
  try {
    stops.push(transport.onEvent('Debugger.scriptParsed', (params, sessionId) => {
      if (!sessions.has(sessionId) || typeof params.scriptId !== 'string' || !params.scriptId || params.scriptLanguage === 'WebAssembly') return
      parsedScripts.push({
        sessionId,
        script: {
          scriptId: params.scriptId,
          url: typeof params.url === 'string' ? params.url : '',
          ...(typeof params.length === 'number' ? { length: params.length } : {}),
          ...(typeof params.hash === 'string' ? { hash: params.hash } : {}),
          ...(typeof params.sourceMapURL === 'string' && params.sourceMapURL ? { sourceMappingURL: params.sourceMapURL } : {}),
        },
      })
    }))
    stops.push(transport.onEvent('Debugger.paused', (_params, sessionId) => {
      if (!sessions.has(sessionId)) return
      try {
        const task = transport.send('Debugger.resume', undefined, sessionId).then(() => {}, (error: unknown) => {
          try { checkSnapshotFailure(transport, error) }
          catch (failure) { failures.push(failure) }
        })
        resumes.add(task)
        void task.then(() => resumes.delete(task))
      } catch (error) { failures.push(error) }
    }))
    const frames = await transport.frames()
    for (const sessionId of new Set(frames.length ? frames.map((frame) => frame.sessionId) : [undefined])) {
      sessions.add(sessionId)
      await transport.send('Debugger.enable', undefined, sessionId)
    }
    await sleep(150)
    transport.assertCurrent()
    const filter = request.filter?.toLowerCase()
    const limit = typeof request.limit === 'number' && Number.isFinite(request.limit) && request.limit > 0 ? Math.floor(request.limit) : 100
    const maxChars = typeof request.maxChars === 'number' && Number.isFinite(request.maxChars) && request.maxChars > 0 ? Math.min(1048576, Math.floor(request.maxChars)) : 131072
    const matched = parsedScripts.filter(({ script }) => filter ? script.url.toLowerCase().includes(filter) : !!script.url)
    const scripts = matched.length > limit ? matched.slice(matched.length - limit) : matched
    for (const entry of scripts) {
      const { script, sessionId } = entry
      if (request.includeSource === true) {
        try {
          const source = await transport.send<{ scriptSource?: string }>('Debugger.getScriptSource', { scriptId: script.scriptId }, sessionId)
          let text = typeof source.scriptSource === 'string' ? source.scriptSource : ''
          if (text) {
            const lines = text.split('\n')
            if (!script.sourceMappingURL && lines.length <= 500 && (lines.some((line) => line.length > 300) || text.length / lines.length > 120)) {
              const formatted = beautifyJavaScript(text)
              if (formatted !== undefined && formatted !== text) { text = formatted; script.beautified = true }
            }
            script.source = text.slice(0, maxChars)
            if (text.length > maxChars) script.sourceTruncated = true
          }
        } catch (error) { checkSnapshotFailure(transport, error) }
      }
      result.push(entry)
    }
    transport.assertCurrent()
  } catch (error) { failures.push(error) }
  try {
    while (resumes.size) await Promise.all([...resumes])
    for (const sessionId of sessions) {
      try { await transport.send('Debugger.disable', undefined, sessionId) }
      catch (error) { failures.push(error) }
    }
  } finally {
    for (const stop of stops) {
      try { stop() }
      catch (error) { failures.push(error) }
    }
  }
  while (resumes.size) await Promise.all([...resumes])
  if (failures.length > 1) throw new AggregateError(failures, 'Script inspection or Debugger cleanup failed', { cause: failures[0] })
  if (failures.length) throw failures[0]
  transport.assertCurrent()
  return result
}

export async function readSourceMap(request: SourceMapRequest, transport: NativeTransport): Promise<Record<string, unknown>> {
  transport.assertCurrent()
  if (!request.scriptId && !request.filter) return { script: { scriptId: '', url: '' }, sourceMapURL: '', error: 'scriptId or filter is required to select a script' }
  const scripts = (await inspectScripts({ kind: 'scripts', ...(request.scriptId ? {} : { filter: request.filter }), limit: 200 }, transport)).filter(({ script }) => !request.scriptId || script.scriptId === request.scriptId)
  const entry = scripts.at(-1)
  if (!entry) return { script: { scriptId: request.scriptId ?? '', url: request.filter ?? '' }, sourceMapURL: '', error: 'no parsed script matched the selector' }
  const { script, sessionId } = entry
  const base = { script: { scriptId: script.scriptId, url: script.url }, sourceMapURL: '', matchedCount: scripts.length }
  if (!script.sourceMappingURL) return { ...base, error: 'script has no source map (Debugger reported no sourceMapURL)' }
  let sourceMapURL = script.sourceMappingURL
  if (!/^data:/u.test(sourceMapURL)) {
    try { sourceMapURL = new URL(sourceMapURL, script.url || undefined).href }
    catch { /* Preserve the reported URL for the loader's structured error. */ }
  }
  base.sourceMapURL = sourceMapURL
  let map: SourceMap
  try {
    map = parseSourceMap(await loadSourceMap(sourceMapURL, script.url, transport, sessionId))
    transport.assertCurrent()
  } catch (error) {
    checkSnapshotFailure(transport, error)
    return { ...base, error: `source map load/parse failed: ${error instanceof Error ? error.message : String(error)}` }
  }
  if (typeof request.line !== 'number' || !Number.isFinite(request.line)) return { ...base, sources: map.sources }
  if (request.line < 1) return { ...base, error: 'line must be a positive 1-based integer' }
  const line = Math.floor(request.line), column = typeof request.column === 'number' && Number.isFinite(request.column) && request.column >= 1 ? request.column : 1
  const position = originalPosition(map, line, column)
  return position ? { ...base, requested: { line, column }, original: position } : { ...base, requested: { line, column }, error: 'generated position maps to no original source (unmapped region)' }
}

async function loadSourceMap(sourceMapURL: string, scriptURL: string, transport: NativeTransport, sessionId?: string): Promise<string> {
  transport.assertCurrent()
  const maxSize = 8 * 1024 * 1024
  const match = /^data:([^,]*),(.*)$/su.exec(sourceMapURL)
  if (match) {
    let text = match[2]
    if (text.length > maxSize * 2) throw new Error('source map exceeds size limit')
    if (/;base64/iu.test(match[1])) text = Buffer.from(text, 'base64').toString('utf8')
    else {
      try { text = decodeURIComponent(text) }
      catch { /* Preserve undecoded data when percent decoding fails, as in IAB. */ }
    }
    if (text.length > maxSize) throw new Error('source map exceeds size limit')
    return text
  }
  const url = safeMapUrl(sourceMapURL, 'source map'), scriptUrl = safeMapUrl(scriptURL, 'script')
  if (url.origin !== scriptUrl.origin) throw new Error('external source map must be same-origin with its script')
  const tree = await transport.send<{ frameTree?: { frame?: { url?: string } } }>('Page.getFrameTree', undefined, sessionId)
  const current = safeMapUrl(tree.frameTree?.frame?.url ?? '', 'page')
  if (url.origin !== current.origin) throw new Error('external source map must be same-origin with the page')
  const response = await transport.send<{ result?: { value?: unknown }; exceptionDetails?: unknown }>('Runtime.evaluate', { expression: `(async()=>{const response=await fetch(${JSON.stringify(url.href)},{credentials:'omit',redirect:'error'});if(!response.ok)throw new Error('source map request failed: '+response.status);const text=await response.text();if(text.length>${maxSize})throw new Error('source map exceeds size limit');return text;})()`, returnByValue: true, awaitPromise: true }, sessionId)
  const text = response.result?.value
  if (!response.exceptionDetails && typeof text === 'string' && text) return text
  throw new Error('same-origin source map fetch failed')
}

// IAB's source-display formatter preserves quoted tokens and comments; it never executes source.
function beautifyJavaScript(source: string): string | undefined {
  const output: string[] = []
  const regexKeywords = new Set(['return', 'typeof', 'instanceof', 'in', 'of', 'new', 'delete', 'void', 'case', 'do', 'else', 'yield', 'await', 'throw'])
  const isWord = (character: string) => /[A-Za-z0-9_$\u0080-￿]/u.test(character)
  const isSpace = (character: string) => character === ' ' || character === '\t' || character === '\r' || character === '\n'
  let indent = 0, parentheses = 0, pendingIndent = -1, previous = '', word = ''
  const newline = (level: number) => { const next = Math.max(0, level); pendingIndent = pendingIndent < 0 ? next : Math.min(pendingIndent, next) }
  const append = (text: string) => { if (pendingIndent >= 0) { output.push('\n', '  '.repeat(pendingIndent)); pendingIndent = -1 } output.push(text) }
  const skipSpace = (offset: number) => { while (offset < source.length && isSpace(source[offset])) offset++; return offset }
  const quotedEnd = (start: number): number | undefined => {
    const quote = source[start]
    for (let offset = start + 1; offset < source.length; offset++) {
      if (source[offset] === '\\') { offset++; continue }
      if (source[offset] === quote) return offset + 1
      if (quote !== '`' && (source[offset] === '\n' || source[offset] === '\r')) return
    }
  }
  const regexEnd = (start: number): number | undefined => {
    let inClass = false
    for (let offset = start + 1; offset < source.length; offset++) {
      const character = source[offset]
      if (character === '\\') { offset++; continue }
      if (character === '\n' || character === '\r') return
      if (inClass) { if (character === ']') inClass = false }
      else if (character === '[') inClass = true
      else if (character === '/') {
        if (source[offset + 1] === '/') return
        offset++
        while (offset < source.length && /[a-z]/iu.test(source[offset])) offset++
        return offset
      }
    }
  }
  for (let offset = 0; offset < source.length;) {
    const character = source[offset]
    if (character === '/' && source[offset + 1] === '/') {
      let end = offset + 2
      while (end < source.length && source[end] !== '\n' && source[end] !== '\r') end++
      append(source.slice(offset, end)); newline(indent); offset = end; continue
    }
    if (character === '/' && source[offset + 1] === '*') {
      const close = source.indexOf('*/', offset + 2), end = close < 0 ? source.length : close + 2
      append(source.slice(offset, end)); offset = end; continue
    }
    if (character === '"' || character === "'" || character === '`') {
      const end = quotedEnd(offset)
      if (end === undefined) return
      append(source.slice(offset, end)); previous = 'quote'; word = ''; offset = end; continue
    }
    if (character === '/') {
      if (!previous || (previous === 'word' ? regexKeywords.has(word) : previous !== ')' && previous !== ']')) {
        const end = regexEnd(offset)
        if (end !== undefined) { append(source.slice(offset, end)); previous = 'quote'; word = ''; offset = end; continue }
      }
      append('/'); previous = '/'; word = ''; offset++; continue
    }
    if (isSpace(character)) {
      const end = skipSpace(offset)
      if (pendingIndent < 0) {
        if (source.slice(offset, end).includes('\n')) newline(indent)
        else output.push(' ')
      }
      offset = end; continue
    }
    if (isWord(character)) {
      let end = offset + 1
      while (end < source.length && isWord(source[end])) end++
      word = source.slice(offset, end); append(word); previous = 'word'; offset = end; continue
    }
    if (character === ';') {
      append(';'); offset = skipSpace(offset + 1); previous = ';'
      if (offset < source.length && parentheses === 0) newline(indent)
      continue
    }
    if (character === '{') {
      append('{'); indent++; parentheses = 0; offset = skipSpace(offset + 1); previous = '{'
      if (offset < source.length) newline(indent)
      continue
    }
    if (character === '}') {
      newline(indent - 1); indent = Math.max(0, indent - 1); parentheses = 0; append('}')
      offset = skipSpace(offset + 1); previous = '}'; word = ''
      if (offset < source.length && !';,)]'.includes(source[offset])) newline(indent)
      continue
    }
    append(character)
    if (character === '(') parentheses++
    else if (character === ')') parentheses = Math.max(0, parentheses - 1)
    previous = character; word = ''; offset++
  }
  if (pendingIndent >= 0) output.push('\n')
  return output.join('')
}

function safeMapUrl(value: string, label: string): URL {
  let url: URL
  try { url = new URL(value) }
  catch { throw new Error(`${label} URL is invalid`) }
  if (!['http:', 'https:'].includes(url.protocol)) throw new Error(`${label} URL must use http or https`)
  if (url.username || url.password) throw new Error(`${label} URL must not contain credentials`)
  return url
}

type SourceMapSegment = { generatedLine: number; generatedColumn: number; sourceIndex?: number; originalLine?: number; originalColumn?: number; nameIndex?: number }
type SourceMap = { sources: string[]; names: string[]; sourcesContent?: unknown[]; segments: SourceMapSegment[] }

function parseSourceMap(text: string): SourceMap {
  let map: { sources?: unknown[]; names?: unknown[]; sourcesContent?: unknown[]; mappings?: string } | null
  try { map = JSON.parse(text) }
  catch (error) { throw new Error(`source map is not valid JSON: ${error instanceof Error ? error.message : String(error)}`, { cause: error }) }
  if (!map || typeof map !== 'object' || !Array.isArray(map.sources)) throw new Error('source map missing sources[]')
  if (typeof map.mappings !== 'string') throw new Error('source map missing mappings')
  const sources = map.sources.map((source) => source === null ? '' : String(source))
  const names = Array.isArray(map.names) ? map.names.map((name) => String(name)) : []
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'
  const segments: SourceMapSegment[] = []
  let generatedLine = 0, sourceIndex = 0, originalLine = 0, originalColumn = 0, nameIndex = 0
  for (const row of map.mappings.split(';')) {
    let generatedColumn = 0
    for (const segment of row.split(',')) {
      if (!segment) continue
      const values: number[] = []
      for (let offset = 0; offset < segment.length;) {
        let value = 0, multiplier = 1, digit: number
        do {
          digit = alphabet.indexOf(segment[offset++] ?? '\0')
          if (digit < 0) throw new Error(`invalid VLQ character in mappings: ${segment[offset - 1]}`)
          value += (digit & 31) * multiplier
          multiplier *= 32
        } while (digit & 32)
        const negative = value % 2 === 1
        value = Math.floor(value / 2)
        values.push(negative ? -value : value)
      }
      generatedColumn += values[0] ?? 0
      const entry: SourceMapSegment = { generatedLine, generatedColumn }
      if (values.length >= 4) {
        sourceIndex += values[1]; originalLine += values[2]; originalColumn += values[3]
        if (sourceIndex < 0 || sourceIndex >= sources.length) throw new Error(`source map segment references source #${sourceIndex} of ${sources.length}`)
        entry.sourceIndex = sourceIndex; entry.originalLine = originalLine; entry.originalColumn = originalColumn
        if (values.length >= 5) { nameIndex += values[4]; entry.nameIndex = nameIndex }
      }
      segments.push(entry)
    }
    generatedLine++
  }
  return { sources, names, ...(Array.isArray(map.sourcesContent) ? { sourcesContent: map.sourcesContent } : {}), segments }
}

// Source Map v3 segments are decoded before lookup; mappings use 0-based positions.
function originalPosition(map: SourceMap, line: number, column: number): Record<string, unknown> | undefined {
  let low = 0, high = map.segments.length - 1, selected = -1
  while (low <= high) {
    const middle = (low + high) >> 1, segment = map.segments[middle]
    if (segment.generatedLine < line - 1 || segment.generatedLine === line - 1 && segment.generatedColumn <= column - 1) { selected = middle; low = middle + 1 }
    else high = middle - 1
  }
  if (selected < 0) return
  const segment = map.segments[selected]
  if (segment.generatedLine !== line - 1 || segment.sourceIndex === undefined || segment.originalLine === undefined) return
  const source = map.sources[segment.sourceIndex] ?? '', name = segment.nameIndex === undefined ? undefined : map.names[segment.nameIndex]
  const position: Record<string, unknown> = { source, line: segment.originalLine + 1, column: (segment.originalColumn ?? 0) + 1, ...(name === undefined ? {} : { name }) }
  const sourceIndex = map.sources.indexOf(source), content = sourceIndex < 0 ? undefined : map.sourcesContent?.[sourceIndex]
  if (typeof content === 'string') {
    const sourceLine = content.split('\n')[segment.originalLine]?.trim()
    if (sourceLine) position.sourceLineText = sourceLine.length > 400 ? `${sourceLine.slice(0, 400)}…` : sourceLine
  }
  return position
}
