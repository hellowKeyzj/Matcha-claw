import { describe, expect, it } from 'vitest';
import type { SessionRenderToolCard } from '../../src/types/session/tool-card';

function buildToolCard(partial: Partial<SessionRenderToolCard>): SessionRenderToolCard {
  return {
    id: partial.id ?? 'tool-1',
    name: partial.name ?? 'read',
    displayTitle: partial.displayTitle ?? partial.name ?? 'read',
    input: partial.input ?? {},
    status: partial.status ?? 'completed',
    result: partial.result ?? { kind: 'none', surface: 'tool-card' },
    ...partial,
  };
}

describe('generated files', () => {
  it('extracts edit tool changes from assistant tool cards', async () => {
    const { extractGeneratedFilesFromToolCards } = await import('@/plugins/files/generated-files');

    const files = extractGeneratedFilesFromToolCards([
      buildToolCard({
        id: 'edit-1',
        name: 'edit',
        input: {
          file_path: '/workspace/demo.ts',
          old_string: 'const value = 1;\n',
          new_string: 'const value = 2;\n',
        },
      }),
    ]);

    expect(files).toEqual([
      expect.objectContaining({
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
      }),
    ]);
  });

  it('extracts write tool snapshots from assistant tool cards', async () => {
    const { extractGeneratedFilesFromToolCards } = await import('@/plugins/files/generated-files');

    const files = extractGeneratedFilesFromToolCards([
      buildToolCard({
        id: 'write-1',
        name: 'write',
        input: {
          filePath: '/workspace/README.md',
          content: '# Matcha\n',
        },
      }),
    ]);

    expect(files).toEqual([
      expect.objectContaining({
        filePath: '/workspace/README.md',
        fileName: 'README.md',
        ext: '.md',
        mimeType: 'text/markdown',
        contentType: 'markdown',
        sourceTool: 'write',
        action: 'created',
        baseline: '',
        content: '# Matcha\n',
        lineStats: { added: 1, removed: 0 },
      }),
    ]);
  });

  it('dedupes later tool updates by file path and keeps the latest content', async () => {
    const { extractGeneratedFilesFromToolCards } = await import('@/plugins/files/generated-files');

    const files = extractGeneratedFilesFromToolCards([
      buildToolCard({
        id: 'write-1',
        name: 'write',
        input: {
          filePath: '/workspace/demo.ts',
          content: 'const value = 1;\n',
        },
      }),
      buildToolCard({
        id: 'edit-2',
        name: 'edit',
        input: {
          file_path: '/workspace/demo.ts',
          old_string: 'const value = 1;\n',
          new_string: 'const value = 2;\n',
        },
      }),
    ]);

    expect(files).toHaveLength(1);
    expect(files[0]).toEqual(expect.objectContaining({
      filePath: '/workspace/demo.ts',
      content: 'const value = 2;\n',
      baseline: 'const value = 1;\n',
    }));
  });

  it('ignores non file-mutating tools', async () => {
    const { extractGeneratedFilesFromToolCards } = await import('@/plugins/files/generated-files');

    const files = extractGeneratedFilesFromToolCards([
      buildToolCard({
        id: 'read-1',
        name: 'read',
        input: { filePath: '/workspace/demo.ts' },
      }),
      buildToolCard({
        id: 'grep-1',
        name: 'grep',
        input: { pattern: 'TODO' },
      }),
    ]);

    expect(files).toEqual([]);
  });

  it('classifies previewable document types for downstream viewers', async () => {
    const { classifyFileContentType, extnameOf, getMimeTypeForPath } = await import('@/plugins/files/file-types');
    const { createPluginHost } = await import('@/plugin-host/core');
    const { applicationShellPlugin } = await import('@/app/extensions');
    const { filesPlugin } = await import('@/plugins/files/plugin');
    const { fileFormats, fileReaders, findFileReader, resolveFilePreviewTarget } = await import('@/plugins/files/extensions');
    const { buildArtifactPreviewTargetFromPath } = await import('@/plugins/files/types');
    const host = createPluginHost([applicationShellPlugin, filesPlugin]);
    const formats = host.get(fileFormats);
    const readers = host.get(fileReaders);
    const target = (ext: string) => resolveFilePreviewTarget(buildArtifactPreviewTargetFromPath(`/workspace/report${ext}`), formats);

    expect(extnameOf('/workspace/Dockerfile')).toBe('.dockerfile');
    expect(getMimeTypeForPath('/workspace/report.pdf', formats)).toBe('application/pdf');
    expect(classifyFileContentType('.xlsx', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', formats)).toBe('sheet');
    expect(classifyFileContentType('.html', 'text/html', formats)).toBe('html');
    expect(classifyFileContentType('.pdf', 'application/pdf', formats)).toBe('pdf');
    expect(classifyFileContentType('.png', 'image/png', formats)).toBe('image');
    expect(findFileReader(readers, target('.pdf'), 'preview')).toMatchObject({ id: 'pdf', source: 'binary' });
    expect(findFileReader(readers, target('.html'), 'preview')).toMatchObject({ id: 'html', source: 'text' });
    expect(findFileReader(readers, target('.xlsx'), 'preview')).toMatchObject({ id: 'sheet', source: 'binary' });
    expect(findFileReader(readers, { ...target('.csv'), baseline: 'a\n', content: 'b\n' }, 'diff')).toMatchObject({ id: 'text-diff', source: 'snapshot' });
    expect(findFileReader(readers, { ...target('.xlsx'), baseline: 'a\n', content: 'b\n' }, 'diff')).toBeUndefined();
    expect(findFileReader(readers, target('.pdf'), 'diff')).toBeUndefined();
  });
});
