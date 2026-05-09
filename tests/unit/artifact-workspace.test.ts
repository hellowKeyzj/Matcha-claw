import { describe, expect, it } from 'vitest';
import { resolveArtifactWorkspaceRoot } from '@/pages/Chat/artifact-workspace';

describe('artifact workspace root', () => {
  it('prefers the agent workspace even when the focused target is a directory', () => {
    expect(resolveArtifactWorkspaceRoot({
      currentWorkspace: '/agent/workspace',
      artifactFiles: [],
      artifactFocusedFile: {
        filePath: '/agent/workspace/generated',
        fileName: 'generated',
        ext: '',
        mimeType: 'application/x-directory',
        contentType: 'binary',
        isDirectory: true,
      },
    })).toBe('/agent/workspace');
  });

  it('prefers the agent workspace when there is no focused directory', () => {
    expect(resolveArtifactWorkspaceRoot({
      currentWorkspace: '/agent/workspace',
      artifactFiles: [],
      artifactFocusedFile: {
        filePath: '/tmp/sales.xlsx',
        fileName: 'sales.xlsx',
        ext: '.xlsx',
        mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        contentType: 'sheet',
      },
    })).toBe('/agent/workspace');
  });

  it('falls back to the generated edit file directory before rich preview files', () => {
    expect(resolveArtifactWorkspaceRoot({
      currentWorkspace: '',
      artifactFiles: [
        {
          filePath: '/workspace/demo.ts',
          fileName: 'demo.ts',
          ext: '.ts',
          mimeType: 'text/typescript',
          contentType: 'code',
          sourceTool: 'edit',
          action: 'modified',
          baseline: 'const value = 1;\n',
          content: 'const value = 2;\n',
          lineStats: { added: 1, removed: 1 },
          toolId: 'edit-1',
        },
        {
          filePath: '/tmp/report.pdf',
          fileName: 'report.pdf',
          ext: '.pdf',
          mimeType: 'application/pdf',
          contentType: 'pdf',
          sourceTool: 'write',
          action: 'created',
          baseline: '',
          content: '',
          lineStats: { added: 0, removed: 0 },
          toolId: 'write-1',
        },
      ],
      artifactFocusedFile: {
        filePath: '/tmp/report.pdf',
        fileName: 'report.pdf',
        ext: '.pdf',
        mimeType: 'application/pdf',
        contentType: 'pdf',
      },
    })).toBe('/workspace');
  });
});
