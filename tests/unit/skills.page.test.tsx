import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const hostApiFetchMock = vi.hoisted(() => vi.fn());

vi.mock('@/lib/host-api', () => ({
  hostApiFetch: (...args: unknown[]) => hostApiFetchMock(...args),
}));

import { Skills } from '@/pages/Skills';
import { clearSkillsStatusCache, decodeSkillsDetail, decodeSkillsStatus, decodeSkillsUninstall, fetchSkillsStatus, refreshSkillsStatus, uploadSkillArchive } from '@/pages/Skills/skills-page-model';

const status = {
  skills: [{
    key: 'calendar', name: 'Calendar', description: 'Calendar integration', enabled: true,
    selectable: true, unavailableReason: null, missingCategories: [],
  }],
};

function renderSkills() {
  return render(<Skills />);
}

describe('Skills page', () => {
  beforeEach(() => {
    hostApiFetchMock.mockReset();
    clearSkillsStatusCache();
  });

  it('strictly rejects unknown response fields', () => {
    expect(() => decodeSkillsStatus({ ...status, privatePath: 'C:/secret' })).toThrow();
    expect(() => decodeSkillsDetail({ skill: null, privatePath: 'C:/secret' })).toThrow();
    expect(decodeSkillsUninstall({ outcome: 'removed' })).toEqual({ outcome: 'removed' });
    expect(() => decodeSkillsUninstall({ outcome: 'accepted' })).toThrow();
    expect(() => decodeSkillsUninstall({ outcome: 'removed', path: 'C:/secret' })).toThrow();
  });

  it('caches status briefly and deduplicates concurrent reads', async () => {
    let resolveStatus: ((value: typeof status) => void) | undefined;
    hostApiFetchMock.mockReturnValueOnce(new Promise<typeof status>((resolve) => { resolveStatus = resolve; }));
    const first = fetchSkillsStatus();
    const second = fetchSkillsStatus();
    expect(hostApiFetchMock).toHaveBeenCalledTimes(1);
    resolveStatus!(status);
    await expect(Promise.all([first, second])).resolves.toEqual([status, status]);
    await expect(fetchSkillsStatus()).resolves.toEqual(status);
    expect(hostApiFetchMock).toHaveBeenCalledTimes(1);
    hostApiFetchMock.mockResolvedValueOnce(status);
    await refreshSkillsStatus();
    expect(hostApiFetchMock).toHaveBeenCalledTimes(2);
  });

  it('renders directory filters and fixed management controls', async () => {
    hostApiFetchMock.mockResolvedValue(status);
    renderSkills();

    expect(await screen.findByRole('heading', { name: '技能管理' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '已启用' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '批量启用' })).toBeInTheDocument();
    expect(screen.getByText('Calendar')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '卸载已选技能' })).toBeDisabled();
    expect(screen.getByLabelText('技能 ZIP 归档文件')).toHaveAttribute('accept', '.zip,application/zip');
  });

  it('searches marketplace, opens detail, installs and updates through concrete endpoints', async () => {
    hostApiFetchMock
      .mockResolvedValueOnce(status)
      .mockResolvedValueOnce({ results: [{ score: 1, slug: 'weather', displayName: 'Weather', summary: 'Forecasts' }] })
      .mockResolvedValueOnce({ skill: { slug: 'weather', displayName: 'Weather', summary: 'Forecasts', createdAt: 1, updatedAt: 2 } })
      .mockResolvedValue({ outcome: 'accepted' });
    renderSkills();

    await screen.findByText('Calendar');
    fireEvent.change(screen.getByLabelText('Marketplace 搜索'), { target: { value: 'weather' } });
    fireEvent.click(screen.getByRole('button', { name: '搜索' }));
    expect(await screen.findByText('Weather')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '详情' }));
    expect(await screen.findByText('Forecasts')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '安装' }));
    await waitFor(() => expect(hostApiFetchMock).toHaveBeenCalledWith('/api/skills/clawhub/install', expect.objectContaining({ method: 'POST' })));
    fireEvent.click(screen.getByRole('button', { name: '更新全部' }));
    await waitFor(() => expect(hostApiFetchMock).toHaveBeenCalledWith('/api/skills/clawhub/update', expect.objectContaining({ method: 'POST' })));
  });

  it('persists force on archive upload begin and omits it from commit', async () => {
    const file = new File(['zip-content'], 'skill.zip', { type: 'application/zip' });
    hostApiFetchMock
      .mockResolvedValueOnce({ uploadId: 'upload-1', receivedBytes: 0, expiresAt: 1 })
      .mockResolvedValueOnce({ uploadId: 'upload-1', receivedBytes: 10, expiresAt: 1 })
      .mockResolvedValueOnce({ uploadId: 'upload-1', receivedBytes: 10, sha256: 'a'.repeat(64), expiresAt: 1 });
    await uploadSkillArchive(file, 'calendar', true);
    expect(hostApiFetchMock.mock.calls[0]).toEqual(['/api/skills/upload/begin', expect.objectContaining({
      body: expect.stringContaining('"force":true'),
    })]);
    const [, commitInit] = hostApiFetchMock.mock.calls.at(-1)!;
    expect(JSON.parse((commitInit as RequestInit).body as string)).toEqual({ uploadId: 'upload-1', sha256: expect.any(String) });
  });

  it('uninstalls selected skill keys without sending paths', async () => {
    hostApiFetchMock
      .mockResolvedValueOnce(status)
      .mockResolvedValueOnce({ outcome: 'removed' })
      .mockResolvedValueOnce(status);
    renderSkills();
    await screen.findByText('Calendar');
    fireEvent.click(screen.getByLabelText('选择 Calendar'));
    fireEvent.click(screen.getByRole('button', { name: '卸载已选技能' }));
    await waitFor(() => expect(hostApiFetchMock).toHaveBeenCalledWith('/api/skills/uninstall', expect.objectContaining({
      method: 'POST',
      body: JSON.stringify({ skillKey: 'calendar' }),
    })));
    expect(hostApiFetchMock.mock.calls.some(([, init]) => String((init as RequestInit | undefined)?.body).includes('C:/'))).toBe(false);
  });

  it('sends secret config without rendering it back and supports batch enabled updates', async () => {
    hostApiFetchMock.mockResolvedValue(status);
    renderSkills();
    await screen.findByText('Calendar');
    fireEvent.click(screen.getByRole('button', { name: '配置' }));
    fireEvent.change(screen.getByLabelText('技能 secret'), { target: { value: 'top-secret' } });
    fireEvent.click(screen.getByRole('button', { name: '保存配置' }));
    await waitFor(() => expect(hostApiFetchMock).toHaveBeenCalledWith('/api/skills/config', expect.objectContaining({ body: expect.stringContaining('top-secret') })));
    expect(screen.queryByText('top-secret')).not.toBeInTheDocument();

    fireEvent.click(screen.getByLabelText('选择 Calendar'));
    fireEvent.click(screen.getByRole('button', { name: '批量停用' }));
    await waitFor(() => expect(hostApiFetchMock).toHaveBeenCalledWith('/api/skills/config', expect.objectContaining({ body: expect.stringContaining('"enabled":false') })));
  });
});
