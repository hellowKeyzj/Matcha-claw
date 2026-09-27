import { Readable } from 'node:stream';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const showOpenDialogMock = vi.hoisted(() => vi.fn());

vi.mock('electron', () => ({
  dialog: { showOpenDialog: showOpenDialogMock },
}));

import { handleSealedSkillsRoutes } from '../../electron/api/routes/sealed-skills';

function incoming(body: unknown, method = 'POST') {
  return Object.assign(Readable.from([JSON.stringify(body)]), {
    method,
    headers: { 'content-type': 'application/json' },
  });
}

function response() {
  const state = { statusCode: 200, body: undefined as unknown };
  return {
    state,
    raw: {
      get statusCode() { return state.statusCode; },
      set statusCode(value: number) { state.statusCode = value; },
      setHeader: () => {},
      end: (content?: string) => { state.body = content ? JSON.parse(content) : undefined; },
    },
  };
}

describe('sealed skills host API route', () => {
  beforeEach(() => {
    showOpenDialogMock.mockReset();
  });

  it('does not enable sealed skill config after package install', async () => {
    const sealedSkillsTransport = {
      install: vi.fn().mockResolvedValue({
        status: 200,
        body: { outcome: 'accepted', skillKey: 'vendor/calendar' },
      }),
      readStatus: vi.fn(),
      export: vi.fn(),
      uninstall: vi.fn(),
    };
    const skillsManagementTransport = {
      mutateConfig: vi.fn().mockResolvedValue({ status: 200, body: { outcome: 'accepted' } }),
    };
    const result = response();

    await expect(handleSealedSkillsRoutes(
      incoming({ packagePath: 'C:/sealed/calendar.matcha-skillpkg' }) as never,
      result.raw as never,
      new URL('http://127.0.0.1/api/sealed-skills/install'),
      sealedSkillsTransport as never,
      skillsManagementTransport as never,
    )).resolves.toBe(true);

    expect(sealedSkillsTransport.install).toHaveBeenCalledWith({ packagePath: 'C:/sealed/calendar.matcha-skillpkg' });
    expect(skillsManagementTransport.mutateConfig).not.toHaveBeenCalled();
    expect(result.state).toEqual({
      statusCode: 200,
      body: { outcome: 'accepted', skillKey: 'vendor/calendar' },
    });
  });

  it('chooses local sealed package in main before installing', async () => {
    showOpenDialogMock.mockResolvedValue({ canceled: false, filePaths: ['C:/sealed/calendar.matcha-skillpkg'] });
    const sealedSkillsTransport = {
      install: vi.fn().mockResolvedValue({
        status: 200,
        body: { outcome: 'accepted', skillKey: 'vendor/calendar' },
      }),
      readStatus: vi.fn(),
      export: vi.fn(),
      uninstall: vi.fn(),
    };
    const skillsManagementTransport = { mutateConfig: vi.fn() };
    const result = response();

    await expect(handleSealedSkillsRoutes(
      incoming({}) as never,
      result.raw as never,
      new URL('http://127.0.0.1/api/sealed-skills/install-local'),
      sealedSkillsTransport as never,
      skillsManagementTransport as never,
    )).resolves.toBe(true);

    expect(showOpenDialogMock).toHaveBeenCalledWith(expect.objectContaining({
      properties: ['openFile'],
      filters: [{ name: 'Matcha sealed skill package', extensions: ['matcha-skillpkg'] }],
    }));
    expect(sealedSkillsTransport.install).toHaveBeenCalledWith({ packagePath: 'C:/sealed/calendar.matcha-skillpkg' });
    expect(skillsManagementTransport.mutateConfig).not.toHaveBeenCalled();
    expect(result.state).toEqual({
      statusCode: 200,
      body: { outcome: 'accepted', skillKey: 'vendor/calendar' },
    });
  });
});
