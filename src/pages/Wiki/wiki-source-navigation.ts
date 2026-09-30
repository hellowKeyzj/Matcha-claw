import MarkdownIt from 'markdown-it';
import type { TFunction } from 'i18next';
import { parse } from 'yaml';
import { hostWikiReadFile, hostWikiSourceFiles } from '@/lib/host-api';
import { normalizeFiles, normalizeRead } from './wiki-model';
import { wikiMediaPath } from './wiki-media';

const markdown = new MarkdownIt({ html: false });

function sourceIdentity(value: string): string | null {
  const normalized = value.replace(/\\/g, '/').replace(/^raw\/sources\//, '');
  if (/^(?:[a-z][a-z0-9+.-]*:|\/)/i.test(normalized)) return null;
  return normalized.split('/').every((part) => part && part !== '.' && part !== '..') ? normalized : null;
}

export async function readOriginalImageSource(projectId: string, pagePath: string, imageSrc: string, t: TFunction<'wiki'>): Promise<Readonly<{ path: string; content: string; imageIndex: number }>> {
  const mediaPath = wikiMediaPath(pagePath, imageSrc);
  const slug = mediaPath?.match(/^wiki\/media\/([^/]+)\//)?.[1];
  if (!slug) throw new Error(t('search.invalidSourceImage', { defaultValue: '图片引用不在知识库媒体目录中，请从来源列表打开原文。' }));
  const summaryPath = `wiki/sources/${slug}.md`;
  const summary = normalizeRead(await hostWikiReadFile({ projectId, path: summaryPath }).catch(() => {
    throw new Error(t('search.sourceSummaryMissing', { defaultValue: '来源摘要无法读取，请重新导入原始来源后重试。' }));
  }), summaryPath);
  const header = summary.content.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/)?.[1];
  const metadata = header ? parse(header) : null;
  const sources: unknown = metadata?.sources;
  const identities = Array.isArray(sources)
    ? sources.flatMap((source) => typeof source === 'string' ? sourceIdentity(source) ?? [] : [])
    : [];
  const files = normalizeFiles(await hostWikiSourceFiles({ projectId }));
  const originals = files.filter((file) => !file.isDirectory && file.path.startsWith('raw/sources/') && identities.includes(file.path.slice('raw/sources/'.length)));
  if (originals.length !== 1) throw new Error(t('search.sourceIdentityMissing', { defaultValue: '无法唯一定位原始来源，请检查来源摘要的 sources 字段及原文是否仍在知识库中。' }));
  const identity = originals[0].path.slice('raw/sources/'.length);
  const path = `raw/parsed/${identity}.md`;
  const parsed = normalizeRead(await hostWikiReadFile({ projectId, path }).catch(() => {
    throw new Error(t('search.sourceArchiveMissing', { defaultValue: '原始解析稿无法读取，请重新导入来源以恢复图片位置。' }));
  }), path);
  let imageIndex = 0;
  for (const token of markdown.parse(parsed.content, {})) {
    for (const child of token.children ?? []) {
      if (child.type !== 'image') continue;
      if (wikiMediaPath(path, child.attrGet('src') ?? '') === mediaPath) return { ...parsed, imageIndex };
      imageIndex++;
    }
  }
  throw new Error(t('search.sourceImageMissing', { defaultValue: '原始解析稿中找不到该图片，请重新导入来源以恢复图片位置。' }));
}
