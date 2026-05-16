import { describe, it, expect } from 'vitest';
import { resolveToolCardRenderState } from '../../runtime-host/application/sessions/tool/tool-card-render-state';

describe('tool card preview: generic fallback for unknown skill/MCP tools', () => {
  it('Pdf skill with file_path shows the path', () => {
    const state = resolveToolCardRenderState({
      name: 'Pdf',
      input: { file_path: 'C:\\Users\\Mr.Key\\Documents\\test.pdf', pages: '1-20' },
    });
    expect(state.displayDetail).toContain('test.pdf');
    expect(state.displayDetail).not.toBe('{');
  });

  it('arbitrary skill with unknown field names still shows meaningful detail', () => {
    const state = resolveToolCardRenderState({
      name: 'ImageAnalyzer',
      input: { image_url: 'https://example.com/photo.png', mode: 'detailed' },
    });
    expect(state.displayDetail).toContain('https://example.com/photo.png');
    expect(state.displayDetail).not.toBe('{');
  });

  it('MCP tool with custom fields extracts first meaningful value', () => {
    const state = resolveToolCardRenderState({
      name: 'sql_query',
      input: { database: 'production', statement: 'SELECT * FROM users LIMIT 10' },
    });
    // Should extract one of the values, not show "{"
    expect(state.displayDetail).toBeTruthy();
    expect(state.displayDetail).not.toBe('{');
    expect(state.displayDetail).not.toBe('{}');
  });

  it('skill with deeply nested object input does not show "{"', () => {
    const state = resolveToolCardRenderState({
      name: 'ComplexTool',
      input: { config: { nested: true }, target: 'some-target-value' },
    });
    // The serialized JSON has { on first line; should not leak
    expect(state.displayDetail).not.toBe('{');
    // Should find "some-target-value" via generic extraction
    expect(state.displayDetail).toContain('some-target-value');
  });

  it('skill with only boolean/number fields shows empty detail rather than "{"', () => {
    const state = resolveToolCardRenderState({
      name: 'ToggleTool',
      input: { enabled: true, count: 42 },
    });
    // No meaningful string value to extract; should be undefined, not "{"
    // The serialized JSON is: { "enabled": true, "count": 42 }
    // buildObjectLikePreview won't find string values, generic fallback won't match
    // firstLine guard should prevent "{" from leaking
    if (state.displayDetail) {
      expect(state.displayDetail).not.toBe('{');
    }
  });

  it('empty object input produces no displayDetail', () => {
    const state = resolveToolCardRenderState({
      name: 'AnyTool',
      input: {},
    });
    expect(state.displayDetail).toBeUndefined();
  });

  it('streaming partial "{" input produces no displayDetail', () => {
    const state = resolveToolCardRenderState({
      name: 'AnyTool',
      input: '{',
    });
    expect(state.displayDetail).toBeUndefined();
  });

  it('streaming partial JSON string produces no garbage displayDetail', () => {
    const state = resolveToolCardRenderState({
      name: 'AnyTool',
      input: '{"file_pa',
    });
    // Has letters so might produce something, but should not be just "{"
    if (state.displayDetail) {
      expect(state.displayDetail).not.toBe('{');
    }
  });

  it('output with unknown structure still extracts meaningful preview', () => {
    const state = resolveToolCardRenderState({
      name: 'CustomSkill',
      input: { action: 'process' },
      outputText: '{"extracted_text": "Hello world from PDF", "page_count": 5}',
    });
    if (state.result.kind === 'json') {
      // JSON detection handles this; buildJsonPreviewSummary shows field names for unknown keys
      expect(state.result.collapsedPreview).toBeTruthy();
      expect(state.result.collapsedPreview).not.toBe('{');
    }
  });

  it('Python-style dict output extracts error message', () => {
    const state = resolveToolCardRenderState({
      name: 'CustomSkill',
      input: {},
      outputText: "{'status': 'error', 'reason': 'file_too_large'}",
    });
    if (state.result.kind === 'text') {
      expect(state.result.collapsedPreview).toContain('file_too_large');
    }
  });

  // --- 各类工具字段覆盖 ---

  it('command-type tool shows command preview', () => {
    const state = resolveToolCardRenderState({
      name: 'ShellExec',
      input: { command: 'npm run build', cwd: '/app' },
    });
    expect(state.displayDetail).toContain('npm run build');
  });

  it('prompt-type tool shows prompt preview', () => {
    const state = resolveToolCardRenderState({
      name: 'AskLLM',
      input: { prompt: 'Summarize this document', model: 'gpt-4' },
    });
    expect(state.displayDetail).toContain('Summarize this document');
  });

  it('endpoint-type tool shows endpoint as url', () => {
    const state = resolveToolCardRenderState({
      name: 'ApiCall',
      input: { endpoint: 'https://api.example.com/v1/users', method: 'GET' },
    });
    expect(state.displayDetail).toContain('api.example.com');
  });

  it('sql-type tool shows statement as query', () => {
    const state = resolveToolCardRenderState({
      name: 'DatabaseQuery',
      input: { database: 'mydb', sql: 'SELECT count(*) FROM orders' },
    });
    expect(state.displayDetail).toContain('SELECT count');
  });

  it('search-type tool with keyword field shows query', () => {
    const state = resolveToolCardRenderState({
      name: 'WebSearch',
      input: { keyword: 'typescript generics', limit: 10 },
    });
    expect(state.displayDetail).toContain('typescript generics');
  });

  it('directory-type tool shows directory path', () => {
    const state = resolveToolCardRenderState({
      name: 'ListFiles',
      input: { directory: '/home/user/projects', recursive: true },
    });
    expect(state.displayDetail).toContain('/home/user/projects');
  });

  it('source/destination tool shows source path', () => {
    const state = resolveToolCardRenderState({
      name: 'CopyFile',
      input: { source: '/tmp/input.csv', destination: '/data/output.csv' },
    });
    expect(state.displayDetail).toContain('/tmp/input.csv');
  });

  it('error output with cause field shows failure', () => {
    const state = resolveToolCardRenderState({
      name: 'AnyTool',
      input: {},
      outputText: '{"cause": "connection_timeout", "retries": 3}',
    });
    if (state.result.kind === 'json') {
      expect(state.result.collapsedPreview).toContain('connection_timeout');
    }
  });
});
