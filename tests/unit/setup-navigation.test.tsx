import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import Setup from '@/pages/Setup';
import { useGatewayStore } from '@/stores/gateway';
import { useSettingsStore } from '@/stores/settings';

const hostApiFetchMock = vi.fn();
const hostOpenClawGetStatusMock = vi.fn();
const hostUvInstallAllMock = vi.fn();

vi.mock('@/lib/host-api', () => ({
  hostApiFetch: (...args: unknown[]) => hostApiFetchMock(...args),
  hostOpenClawGetStatus: (...args: unknown[]) => hostOpenClawGetStatusMock(...args),
  hostUvInstallAll: (...args: unknown[]) => hostUvInstallAllMock(...args),
}));

describe('setup navigation', () => {
  beforeEach(() => {
    vi.useRealTimers();
    vi.clearAllMocks();

    useSettingsStore.setState({
      language: 'en',
      setupComplete: false,
      initialized: true,
      init: vi.fn().mockResolvedValue(undefined),
    } as never);

    useGatewayStore.setState({
      status: {
        processState: 'running',
        port: 18789,
        gatewayReady: true,
        healthSummary: 'healthy',
        transportState: 'connected',
        portReachable: true,
        diagnostics: {
          consecutiveHeartbeatMisses: 0,
          consecutiveRpcFailures: 0,
        },
        updatedAt: Date.now(),
      },
      start: vi.fn().mockResolvedValue(undefined),
    } as never);

    hostApiFetchMock.mockImplementation(async (path: string) => {
      if (path === '/api/license/stored-key') {
        return { key: 'MATCHACLAW-TEST-KEY-0000-0000-0000' };
      }
      if (path === '/api/license/gate') {
        return {
          state: 'blocked',
          lastValidation: null,
        };
      }
      if (path === '/api/license/validate') {
        return {
          valid: true,
          code: 'valid',
          normalizedKey: 'MATCHACLAW-TEST-KEY-0000-0000-0000',
        };
      }
      if (path === '/api/logs') {
        return { content: '' };
      }
      if (path === '/api/logs/dir') {
        return { dir: null };
      }
      throw new Error(`Unexpected hostApiFetch path: ${path}`);
    });

    hostOpenClawGetStatusMock.mockResolvedValue({
      packageExists: true,
      isBuilt: true,
      dir: '/tmp/openclaw',
      version: '2026.4.15',
    });

    hostUvInstallAllMock.mockResolvedValue({ success: true });
  });

  it('runtime step proceeds directly to installing without provider step', async () => {
    render(
      <MemoryRouter>
        <Setup />
      </MemoryRouter>,
    );

    fireEvent.change(await screen.findByLabelText('License Key'), {
      target: { value: 'MATCHACLAW-TEST-KEY-0000-0000-0000' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Validate' }));
    const welcomeNextButton = screen.getByRole('button', { name: 'Next' });
    await waitFor(() => {
      expect(welcomeNextButton).toBeEnabled();
    });
    fireEvent.click(welcomeNextButton);

    expect(await screen.findByRole('heading', { name: 'Environment Check' })).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'AI Provider' })).not.toBeInTheDocument();

    const nextButton = screen.getByRole('button', { name: 'Next' });
    await waitFor(() => {
      expect(nextButton).toBeEnabled();
    });

    fireEvent.click(nextButton);

    expect(await screen.findByRole('heading', { name: 'Setting Up' })).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'AI Provider' })).not.toBeInTheDocument();
    expect(hostUvInstallAllMock).toHaveBeenCalledTimes(1);
  });
});
