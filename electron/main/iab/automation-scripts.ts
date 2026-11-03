import type { BrowserUtilityRequest } from '../../../packages/openclaw-browser-relay-plugin/src/browser-action-contract';
import type { IabJsonObject } from '../../../src/types/desktop/iab';
import { IabAutomationPage, type Operation } from './automation-page';
import { iabError } from './error';

type ScriptRequest = Extract<BrowserUtilityRequest, { kind: 'scripts' }>;
type SourceMapRequest = Extract<BrowserUtilityRequest, { kind: 'sourceMap' }>;

export async function readScripts(page: IabAutomationPage, request: ScriptRequest, operation: Operation): Promise<IabJsonObject[]> {
  if (request.includeSource === true && !request.filter) throw iabError('IAB_SCRIPT_FILTER_REQUIRED', 'includeSource requires a URL filter');
  const frames = await page.executor.listChildFrames({ signal: operation.signal, timeoutMs: Math.max(1, operation.deadline - Date.now()), assertCurrent: operation.assertCurrent ?? page.assertCurrent });
  const sessions = new Set<string | undefined>();
  const resumes = new Set<Promise<void>>();
  const failures: unknown[] = [];
  const parsedScripts: IabJsonObject[] = [];
  const result: IabJsonObject[] = [];
  const stop = page.executor.onEvent((event) => {
    if (!sessions.has(event.sessionId)) return;
    if (event.method === 'Debugger.scriptParsed' && typeof event.params.scriptId === 'string' && event.params.scriptId && event.params.scriptLanguage !== 'WebAssembly') {
      parsedScripts.push({ ...event.params, url: typeof event.params.url === 'string' ? event.params.url : '', ...(event.sessionId ? { sessionId: event.sessionId } : {}) });
    }
    if (event.method !== 'Debugger.paused') return;
    try {
      const task = page.send('Debugger.resume', undefined, operation, event.sessionId).then(() => {}, (error: unknown) => {
        try { rethrowOperationFailure(error, page, operation); }
        catch (failure) { failures.push(failure); }
      });
      resumes.add(task); page.trackOperation(task);
      void task.then(() => resumes.delete(task));
    } catch (error) { failures.push(error); }
  });
  try {
    for (const sessionId of new Set([undefined, ...frames.map((frame) => frame.sessionId)])) {
      sessions.add(sessionId);
      await page.send('Debugger.enable', undefined, operation, sessionId);
    }
    await page.pause(150, operation);
    const filter = request.filter?.toLowerCase();
    const limit = typeof request.limit === 'number' && Number.isFinite(request.limit) && request.limit > 0 ? Math.floor(request.limit) : 100;
    const maxChars = typeof request.maxChars === 'number' && Number.isFinite(request.maxChars) && request.maxChars > 0 ? Math.min(1048576, Math.floor(request.maxChars)) : 131072;
    const matched = parsedScripts.filter((script) => filter ? String(script.url).toLowerCase().includes(filter) : !!script.url);
    const scripts = matched.length > limit ? matched.slice(matched.length - limit) : matched;
    for (const script of scripts) {
      const entry: IabJsonObject = { scriptId: script.scriptId, url: script.url, ...(typeof script.length === 'number' ? { length: script.length } : {}), ...(script.hash ? { hash: script.hash } : {}), ...(script.sourceMapURL ? { sourceMappingURL: script.sourceMapURL } : {}), ...(script.sessionId ? { sessionId: script.sessionId } : {}) };
      if (request.includeSource === true) {
        try {
          const source = await page.send<any>('Debugger.getScriptSource', { scriptId: script.scriptId }, operation, script.sessionId as string | undefined);
          let text: string = typeof source?.scriptSource === 'string' ? source.scriptSource : '';
          if (text) {
            const lines = text.split('\n');
            if (!script.sourceMapURL && lines.length <= 500 && (lines.some((line) => line.length > 300) || text.length / lines.length > 120)) {
              const formatted = beautifyJavaScript(text);
              if (formatted !== undefined && formatted !== text) { text = formatted; entry.beautified = true; }
            }
            entry.source = text.slice(0, maxChars);
            if (text.length > maxChars) entry.sourceTruncated = true;
          }
        } catch (error) { rethrowOperationFailure(error, page, operation); }
      }
      result.push(entry);
    }
  } catch (error) { failures.push(error); }
  try {
    while (resumes.size) await Promise.all([...resumes]);
    for (const sessionId of sessions) {
      try { await page.executor.send('Debugger.disable', undefined, { sessionId, signal: operation.signal, timeoutMs: 5000, assertCurrent: operation.assertCurrent ?? page.assertCurrent }); }
      catch (error) { failures.push(error); }
    }
  } finally { stop(); }
  await Promise.all([...resumes]);
  if (failures.length > 1) throw new AggregateError(failures, 'Script inspection or Debugger cleanup failed', { cause: failures[0] });
  if (failures.length) throw failures[0];
  return result;
}

export async function readSourceMap(page: IabAutomationPage, request: SourceMapRequest, operation: Operation): Promise<IabJsonObject> {
  if (!request.scriptId && !request.filter) return { script: { scriptId: '', url: '' }, sourceMapURL: '', error: 'scriptId or filter is required to select a script' };
  const scripts = (await readScripts(page, { kind: 'scripts', ...(request.scriptId ? {} : { filter: request.filter }), limit: 200 }, operation)).filter((script) => !request.scriptId || script.scriptId === request.scriptId);
  const script = scripts.at(-1);
  if (!script) return { script: { scriptId: request.scriptId ?? '', url: request.filter ?? '' }, sourceMapURL: '', error: 'no parsed script matched the selector' };
  const base: IabJsonObject = { script: { scriptId: script.scriptId, url: script.url }, sourceMapURL: '', matchedCount: scripts.length };
  if (!script.sourceMappingURL) return { ...base, error: 'script has no source map (Debugger reported no sourceMapURL)' };
  let sourceMapURL = String(script.sourceMappingURL);
  if (!/^data:/u.test(sourceMapURL)) {
    try { sourceMapURL = new URL(sourceMapURL, String(script.url) || undefined).href; }
    catch { /* Preserve the reported URL for the loader's structured error. */ }
  }
  base.sourceMapURL = sourceMapURL;
  let map: SourceMap;
  try { map = parseSourceMap(await loadSourceMap(page, sourceMapURL, String(script.url), operation, typeof script.sessionId === 'string' ? script.sessionId : undefined)); }
  catch (error) {
    rethrowOperationFailure(error, page, operation);
    return { ...base, error: `source map load/parse failed: ${error instanceof Error ? error.message : String(error)}` };
  }
  if (typeof request.line !== 'number' || !Number.isFinite(request.line)) return { ...base, sources: map.sources };
  if (request.line < 1) return { ...base, error: 'line must be a positive 1-based integer' };
  const line = Math.floor(request.line), column = typeof request.column === 'number' && Number.isFinite(request.column) && request.column >= 1 ? request.column : 1;
  const position = originalPosition(map, line, column);
  return position ? { ...base, requested: { line, column }, original: position } : { ...base, requested: { line, column }, error: 'generated position maps to no original source (unmapped region)' };
}

function rethrowOperationFailure(error: unknown, page: IabAutomationPage, operation: Operation): void {
  operation.signal.throwIfAborted();
  (operation.assertCurrent ?? page.assertCurrent)();
  if (operation.deadline <= Date.now() || error instanceof Error && (error.name === 'TimeoutError' || 'code' in error && typeof error.code === 'string' && error.code.startsWith('IAB_'))) throw error;
}

async function loadSourceMap(page: IabAutomationPage, sourceMapURL: string, scriptURL: string, operation: Operation, sessionId?: string): Promise<string> {
  operation.signal.throwIfAborted();
  (operation.assertCurrent ?? page.assertCurrent)();
  if (operation.deadline <= Date.now()) throw iabError('IAB_TIMEOUT', 'Browser operation timed out');
  const maxSize = 8 * 1024 * 1024;
  const match = /^data:([^,]*),(.*)$/su.exec(sourceMapURL);
  if (match) {
    let text = match[2];
    if (text.length > maxSize * 2) throw new Error('source map exceeds size limit');
    if (/;base64/iu.test(match[1])) text = Buffer.from(text, 'base64').toString('utf8');
    else {
      try { text = decodeURIComponent(text); }
      catch { /* Accio uses the undecoded data when percent decoding fails. */ }
    }
    if (text.length > maxSize) throw new Error('source map exceeds size limit');
    return text;
  }
  const url = safeMapUrl(sourceMapURL, 'source map'), scriptUrl = safeMapUrl(scriptURL, 'script');
  if (url.origin !== scriptUrl.origin) throw new Error('external source map must be same-origin with its script');
  const current = safeMapUrl((await page.send<any>('Page.getFrameTree', undefined, operation, sessionId))?.frameTree?.frame?.url ?? '', 'page');
  if (url.origin !== current.origin) throw new Error('external source map must be same-origin with the page');
  const response = await page.send<any>('Runtime.evaluate', { expression: `(async()=>{const response=await fetch(${JSON.stringify(url.href)},{credentials:'omit',redirect:'error'});if(!response.ok)throw new Error('source map request failed: '+response.status);const text=await response.text();if(text.length>${maxSize})throw new Error('source map exceeds size limit');return text;})()`, returnByValue: true, awaitPromise: true }, operation, sessionId);
  const text = response?.result?.value;
  if (!response?.exceptionDetails && typeof text === 'string' && text) return text;
  throw new Error('same-origin source map fetch failed');
}

// Accio's source-display formatter preserves quoted tokens and comments; it never executes source.
function beautifyJavaScript(source: string): string | undefined {
  const output: string[] = [];
  const regexKeywords = new Set(['return', 'typeof', 'instanceof', 'in', 'of', 'new', 'delete', 'void', 'case', 'do', 'else', 'yield', 'await', 'throw']);
  const isWord = (character: string) => /[A-Za-z0-9_$\u0080-￿]/u.test(character);
  const isSpace = (character: string) => character === ' ' || character === '\t' || character === '\r' || character === '\n';
  let indent = 0, parentheses = 0, pendingIndent = -1, previous = '', word = '';
  const newline = (level: number) => { const next = Math.max(0, level); pendingIndent = pendingIndent < 0 ? next : Math.min(pendingIndent, next); };
  const append = (text: string) => { if (pendingIndent >= 0) { output.push('\n', '  '.repeat(pendingIndent)); pendingIndent = -1; } output.push(text); };
  const skipSpace = (offset: number) => { while (offset < source.length && isSpace(source[offset])) offset++; return offset; };
  const quotedEnd = (start: number): number | undefined => {
    const quote = source[start];
    for (let offset = start + 1; offset < source.length; offset++) {
      if (source[offset] === '\\') { offset++; continue; }
      if (source[offset] === quote) return offset + 1;
      if (quote !== '`' && (source[offset] === '\n' || source[offset] === '\r')) return;
    }
  };
  const regexEnd = (start: number): number | undefined => {
    let inClass = false;
    for (let offset = start + 1; offset < source.length; offset++) {
      const character = source[offset];
      if (character === '\\') { offset++; continue; }
      if (character === '\n' || character === '\r') return;
      if (inClass) { if (character === ']') inClass = false; }
      else if (character === '[') inClass = true;
      else if (character === '/') {
        if (source[offset + 1] === '/') return;
        offset++;
        while (offset < source.length && /[a-z]/iu.test(source[offset])) offset++;
        return offset;
      }
    }
  };
  for (let offset = 0; offset < source.length;) {
    const character = source[offset];
    if (character === '/' && source[offset + 1] === '/') {
      let end = offset + 2;
      while (end < source.length && source[end] !== '\n' && source[end] !== '\r') end++;
      append(source.slice(offset, end)); newline(indent); offset = end; continue;
    }
    if (character === '/' && source[offset + 1] === '*') {
      const close = source.indexOf('*/', offset + 2), end = close < 0 ? source.length : close + 2;
      append(source.slice(offset, end)); offset = end; continue;
    }
    if (character === '"' || character === "'" || character === '`') {
      const end = quotedEnd(offset);
      if (end === undefined) return;
      append(source.slice(offset, end)); previous = 'quote'; word = ''; offset = end; continue;
    }
    if (character === '/') {
      if (!previous || (previous === 'word' ? regexKeywords.has(word) : previous !== ')' && previous !== ']')) {
        const end = regexEnd(offset);
        if (end !== undefined) { append(source.slice(offset, end)); previous = 'quote'; word = ''; offset = end; continue; }
      }
      append('/'); previous = '/'; word = ''; offset++; continue;
    }
    if (isSpace(character)) {
      const end = skipSpace(offset);
      if (pendingIndent < 0) {
        if (source.slice(offset, end).includes('\n')) newline(indent);
        else output.push(' ');
      }
      offset = end; continue;
    }
    if (isWord(character)) {
      let end = offset + 1;
      while (end < source.length && isWord(source[end])) end++;
      word = source.slice(offset, end); append(word); previous = 'word'; offset = end; continue;
    }
    if (character === ';') {
      append(';'); offset = skipSpace(offset + 1); previous = ';';
      if (offset < source.length && parentheses === 0) newline(indent);
      continue;
    }
    if (character === '{') {
      append('{'); indent++; parentheses = 0; offset = skipSpace(offset + 1); previous = '{';
      if (offset < source.length) newline(indent);
      continue;
    }
    if (character === '}') {
      newline(indent - 1); indent = Math.max(0, indent - 1); parentheses = 0; append('}');
      offset = skipSpace(offset + 1); previous = '}'; word = '';
      if (offset < source.length && !';,)]'.includes(source[offset])) newline(indent);
      continue;
    }
    append(character);
    if (character === '(') parentheses++;
    else if (character === ')') parentheses = Math.max(0, parentheses - 1);
    previous = character; word = ''; offset++;
  }
  if (pendingIndent >= 0) output.push('\n');
  return output.join('');
}

function safeMapUrl(value: string, label: string): URL {
  let url: URL;
  try { url = new URL(value); }
  catch { throw new Error(`${label} URL is invalid`); }
  if (!['http:', 'https:'].includes(url.protocol)) throw new Error(`${label} URL must use http or https`);
  if (url.username || url.password) throw new Error(`${label} URL must not contain credentials`);
  return url;
}

type SourceMapSegment = { generatedLine: number; generatedColumn: number; sourceIndex?: number; originalLine?: number; originalColumn?: number; nameIndex?: number };
type SourceMap = { sources: string[]; names: string[]; sourcesContent?: unknown[]; segments: SourceMapSegment[] };

function parseSourceMap(text: string): SourceMap {
  let map: any;
  try { map = JSON.parse(text); }
  catch (error) { throw new Error(`source map is not valid JSON: ${error instanceof Error ? error.message : String(error)}`, { cause: error }); }
  if (!map || typeof map !== 'object' || !Array.isArray(map.sources)) throw new Error('source map missing sources[]');
  if (typeof map.mappings !== 'string') throw new Error('source map missing mappings');
  const sources = map.sources.map((source: unknown) => source === null ? '' : String(source));
  const names = Array.isArray(map.names) ? map.names.map((name: unknown) => String(name)) : [];
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
  const segments: SourceMapSegment[] = [];
  let generatedLine = 0, sourceIndex = 0, originalLine = 0, originalColumn = 0, nameIndex = 0;
  for (const row of map.mappings.split(';')) {
    let generatedColumn = 0;
    for (const segment of row.split(',')) {
      if (!segment) continue;
      const values: number[] = [];
      for (let offset = 0; offset < segment.length;) {
        let value = 0, multiplier = 1, digit: number;
        do {
          digit = alphabet.indexOf(segment[offset++] ?? '\0');
          if (digit < 0) throw new Error(`invalid VLQ character in mappings: ${segment[offset - 1]}`);
          value += (digit & 31) * multiplier;
          multiplier *= 32;
        } while (digit & 32);
        const negative = value % 2 === 1;
        value = Math.floor(value / 2);
        values.push(negative ? -value : value);
      }
      generatedColumn += values[0] ?? 0;
      const entry: SourceMapSegment = { generatedLine, generatedColumn };
      if (values.length >= 4) {
        sourceIndex += values[1]; originalLine += values[2]; originalColumn += values[3];
        if (sourceIndex < 0 || sourceIndex >= sources.length) throw new Error(`source map segment references source #${sourceIndex} of ${sources.length}`);
        entry.sourceIndex = sourceIndex; entry.originalLine = originalLine; entry.originalColumn = originalColumn;
        if (values.length >= 5) { nameIndex += values[4]; entry.nameIndex = nameIndex; }
      }
      segments.push(entry);
    }
    generatedLine++;
  }
  return { sources, names, ...(Array.isArray(map.sourcesContent) ? { sourcesContent: map.sourcesContent } : {}), segments };
}

// Source Map v3 segments are decoded before lookup; mappings use 0-based positions.
function originalPosition(map: SourceMap, line: number, column: number): IabJsonObject | undefined {
  let low = 0, high = map.segments.length - 1, selected = -1;
  while (low <= high) {
    const middle = (low + high) >> 1, segment = map.segments[middle];
    if (segment.generatedLine < line - 1 || segment.generatedLine === line - 1 && segment.generatedColumn <= column - 1) { selected = middle; low = middle + 1; }
    else high = middle - 1;
  }
  if (selected < 0) return;
  const segment = map.segments[selected];
  if (segment.generatedLine !== line - 1 || segment.sourceIndex === undefined || segment.originalLine === undefined) return;
  const source = map.sources[segment.sourceIndex] ?? '', name = segment.nameIndex === undefined ? undefined : map.names[segment.nameIndex];
  const position: IabJsonObject = { source, line: segment.originalLine + 1, column: (segment.originalColumn ?? 0) + 1, ...(name === undefined ? {} : { name }) };
  const sourceIndex = map.sources.indexOf(source), content = sourceIndex < 0 ? undefined : map.sourcesContent?.[sourceIndex];
  if (typeof content === 'string') {
    const sourceLine = content.split('\n')[segment.originalLine]?.trim();
    if (sourceLine) position.sourceLineText = sourceLine.length > 400 ? `${sourceLine.slice(0, 400)}…` : sourceLine;
  }
  return position;
}
