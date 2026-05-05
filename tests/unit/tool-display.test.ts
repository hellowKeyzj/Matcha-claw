import { describe, expect, it } from 'vitest';
import {
  formatToolDetail,
  formatToolSummary,
  resolveToolDisplay,
  resolveToolDisplaySummary,
} from '../../runtime-host/shared/tool-display';

describe('tool display summary', () => {
  it('formats read detail with line range and path', () => {
    const display = resolveToolDisplay({
      name: 'read',
      args: {
        file_path: 'C:\\Users\\Mr.Key\\.openclaw\\skills\\demo.txt',
        offset: 1,
        limit: 250,
      },
    });

    expect(display.title).toBe('读取');
    expect(formatToolDetail(display)).toContain('读取 1-250 行');
    expect(formatToolDetail(display)).toContain('.openclaw\\skills\\demo.txt');
  });

  it('formats web_search detail as chinese summary', () => {
    const display = resolveToolDisplay({
      name: 'web_search',
      args: {
        query: 'GitHub Trending 今天 GitHub 热门项目',
        count: 8,
      },
    });

    expect(formatToolDetail(display)).toBe('搜索“GitHub Trending 今天 GitHub 热门项目”，Top 8');
  });

  it('formats web_fetch detail as chinese summary', () => {
    const display = resolveToolDisplay({
      name: 'web_fetch',
      args: {
        url: 'https://github.com/trending',
        extractMode: 'markdown',
        maxChars: 12000,
      },
    });

    expect(formatToolDetail(display)).toBe('抓取 https://github.com/trending，markdown，最多 12000 字');
  });

  it('formats exec detail using summarized command and workdir', () => {
    const display = resolveToolDisplay({
      name: 'exec',
      args: {
        command: 'git -C C:\\repo status --short',
        workdir: 'C:\\repo',
      },
    });

    expect(display.title).toBe('执行');
    expect(formatToolDetail(display)).toContain('检查 Git 状态');
  });

  it('resolves action specific message detail', () => {
    const summary = resolveToolDisplaySummary({
      name: 'message',
      args: {
        action: 'send',
        provider: 'discord',
        to: 'general',
        content: 'hello',
      },
    });

    expect(summary.title).toBe('消息');
    expect(summary.detail).toContain('发送到 general');
    expect(summary.detail).toContain('通过 discord');
  });

  it('formats browser action detail with user-facing chinese summary', () => {
    const display = resolveToolDisplay({
      name: 'browser',
      args: {
        action: 'open',
        targetUrl: 'https://example.com',
      },
    });

    expect(display.title).toBe('浏览器');
    expect(formatToolDetail(display)).toBe('打开网页 https://example.com');
  });

  it('formats browser status detail as user-facing chinese summary', () => {
    const display = resolveToolDisplay({
      name: 'browser',
      args: {
        action: 'status',
        targetId: 'tab-1',
      },
    });

    expect(formatToolDetail(display)).toBe('查看浏览器状态，tab-1');
  });

  it('formats subagents action detail with chinese summary', () => {
    const display = resolveToolDisplay({
      name: 'subagents',
      args: {
        action: 'kill',
        target: 'writer',
      },
    });

    expect(display.title).toBe('智能体');
    expect(formatToolDetail(display)).toBe('结束 writer');
  });

  it('formats message thread-list detail as user-facing chinese summary', () => {
    const display = resolveToolDisplay({
      name: 'message',
      args: {
        action: 'thread-list',
        to: 'general',
      },
    });

    expect(formatToolDetail(display)).toBe('查看线程列表，位置 general');
  });

  it('formats sessions_send detail as user-facing chinese summary', () => {
    const display = resolveToolDisplay({
      name: 'sessions_send',
      args: {
        label: '主会话',
        timeoutSeconds: 30,
      },
    });

    expect(display.title).toBe('会话发送');
    expect(formatToolDetail(display)).toBe('发送到 主会话，超时 30 秒');
  });

  it('formats cron run detail as user-facing chinese summary', () => {
    const display = resolveToolDisplay({
      name: 'cron',
      args: {
        action: 'run',
        id: 'job-daily',
      },
    });

    expect(display.title).toBe('定时任务');
    expect(formatToolDetail(display)).toBe('立即执行 job-daily');
  });

  it('formats nodes approve detail as user-facing chinese summary', () => {
    const display = resolveToolDisplay({
      name: 'nodes',
      args: {
        action: 'approve',
        requestId: 'req-1',
      },
    });

    expect(display.title).toBe('节点');
    expect(formatToolDetail(display)).toBe('批准请求 req-1');
  });

  it('formats tool summary line from summary object', () => {
    expect(formatToolSummary({
      name: 'read',
      title: '读取',
      label: '读取',
      detail: '读取 1-20 行，README.md',
    })).toBe('读取：读取 1-20 行，README.md');
  });
});
