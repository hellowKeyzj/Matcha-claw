import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import Setup from '@/pages/Setup';
import { useGatewayStore } from '@/stores/gateway';
import { useSettingsStore } from '@/stores/settings';

const platformRuntimeEndpoint = {
  kind: 'native-runtime',
  runtimeAdapterId: 'openclaw',
  runtimeInstanceId: 'local',
} as const;
const hostOpenClawGetStatusMock = vi.hoisted(() => vi.fn());
const licenseRuntimeMock = vi.hoisted(() => ({
  gate: vi.fn(),
  storedKey: vi.fn(),
  validate: vi.fn(),
}));
const runtimeInstallMock = vi.hoisted(() => ({
  resolveScope: vi.fn(),
  hostUvInstallAll: vi.fn(),
}));

vi.mock('@/lib/host-api', () => ({
  hostApiFetch: async (path: string) => {
    if (path === '/api/license/stored-key') {
      return await licenseRuntimeMock.storedKey();
    }
    if (path === '/api/license/gate') {
      return await licenseRuntimeMock.gate();
    }
    throw new Error(`Unexpected hostApiFetch path: ${path}`);
  },
  hostOpenClawGetStatus: (...args: unknown[]) => hostOpenClawGetStatusMock(...args),
  resolveSingleCapabilityScope: (...args: unknown[]) => runtimeInstallMock.resolveScope(...args),
  hostUvInstallAll: (...args: unknown[]) => runtimeInstallMock.hostUvInstallAll(...args),
}));

vi.mock('@/lib/license-runtime', () => ({
  hostLicenseValidate: licenseRuntimeMock.validate,
}));

async function advanceToInstalling() {
  render(
    <MemoryRouter>
      <Setup />
    </MemoryRouter>,
  );

  fireEvent.change(await screen.findByLabelText('License Key'), {
    target: { value: 'test-license-key' },
  });
  fireEvent.click(screen.getByRole('button', { name: 'Validate' }));
  const welcomeNextButton = screen.getByRole('button', { name: 'Next' });
  await waitFor(() => {
    expect(welcomeNextButton).toBeEnabled();
  });
  fireEvent.click(welcomeNextButton);

  expect(await screen.findByRole('heading', { name: 'Environment Check' })).toBeInTheDocument();
  expect(await screen.findByText('Running on port 18789')).toBeInTheDocument();
  expect(screen.getByText('Node.js is available')).toBeInTheDocument();
  expect(screen.queryByRole('heading', { name: 'AI Provider' })).not.toBeInTheDocument();

  const runtimeNextButton = screen.getByRole('button', { name: 'Next' });
  await waitFor(() => {
    expect(runtimeNextButton).toBeEnabled();
  });
  fireEvent.click(runtimeNextButton);

  expect(await screen.findByRole('heading', { name: 'Setting Up' })).toBeInTheDocument();
}

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

    licenseRuntimeMock.gate.mockResolvedValue({
      state: 'blocked',
      reason: 'empty',
      checkedAtMs: Date.now(),
      hasStoredKey: false,
      hasUsableCache: false,
      nextRevalidateAtMs: null,
      lastValidation: null,
      renewalAlert: null,
    });
    licenseRuntimeMock.storedKey.mockResolvedValue({ masked: null });
    licenseRuntimeMock.validate.mockResolvedValue({
      valid: true,
      code: 'valid',
      masked: 'MATCHACLAW-****-****-****-E2E1',
      last4: 'E2E1',
    });

    runtimeInstallMock.resolveScope.mockResolvedValue({
      kind: 'runtime-instance',
      endpoint: platformRuntimeEndpoint,
    });
    runtimeInstallMock.hostUvInstallAll.mockResolvedValue(undefined);

    hostOpenClawGetStatusMock.mockResolvedValue({
      packageExists: true,
      isBuilt: true,
      version: '2026.4.15',
    });
  });

  it('shows the installing transition and submits uv installation to the resolved runtime', async () => {
    runtimeInstallMock.hostUvInstallAll.mockImplementation(() => new Promise(() => {}));

    await advanceToInstalling();

    await waitFor(() => {
      expect(runtimeInstallMock.resolveScope).toHaveBeenCalledWith('platform.runtime');
      expect(runtimeInstallMock.hostUvInstallAll).toHaveBeenCalledWith(platformRuntimeEndpoint);
      expect(screen.getAllByText('Installing...')).toHaveLength(5);
    });
    expect(screen.queryByRole('heading', { name: 'All Set!' })).not.toBeInTheDocument();
  });

  it('completes the four-step flow after uv installation succeeds', async () => {
    await advanceToInstalling();

    expect(await screen.findByRole('heading', { name: 'All Set!' }, { timeout: 4000 })).toBeInTheDocument();
    expect(screen.getByText('OpenCode, Python Environment, Code Assist, File Tools, Terminal')).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'Setting Up' })).not.toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'AI Provider' })).not.toBeInTheDocument();
    expect(runtimeInstallMock.hostUvInstallAll).toHaveBeenCalledWith(platformRuntimeEndpoint);
  });

  it('shows failed installation and exposes the reload retry action', async () => {
    runtimeInstallMock.hostUvInstallAll.mockRejectedValue(new Error('UV installation failed'));

    await advanceToInstalling();

    expect(await screen.findByText('Error: UV installation failed')).toBeInTheDocument();
    expect(screen.getAllByText('Failed')).toHaveLength(5);
    expect(screen.getByRole('button', { name: 'Try restarting the app' })).toBeEnabled();
    expect(screen.queryByRole('heading', { name: 'All Set!' })).not.toBeInTheDocument();
    expect(runtimeInstallMock.hostUvInstallAll).toHaveBeenCalledWith(platformRuntimeEndpoint);

    expect(() => fireEvent.click(screen.getByRole('button', { name: 'Try restarting the app' }))).not.toThrow();
  });
});
