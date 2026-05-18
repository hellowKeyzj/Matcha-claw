import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, useLocation } from 'react-router-dom';
import { TitleBar } from '@/components/layout/TitleBar';

const invokeIpcMock = vi.hoisted(() => vi.fn());

vi.mock('@/lib/api-client', () => ({
  invokeIpc: (...args: unknown[]) => invokeIpcMock(...args),
}));

function CurrentPath() {
  const location = useLocation();
  return <div data-testid="current-path">{location.pathname}</div>;
}

describe('TitleBar platform behavior', () => {
  beforeEach(() => {
    invokeIpcMock.mockReset();
    invokeIpcMock.mockResolvedValue(false);
  });

  it('renders macOS drag region with a settings button', () => {
    window.electron.platform = 'darwin';
    const { container } = render(
      <MemoryRouter>
        <TitleBar />
        <CurrentPath />
      </MemoryRouter>,
    );
    expect(container.querySelector('.drag-region')).toBeInTheDocument();
    const settingsButton = container.querySelector('.no-drag button');
    expect(settingsButton).toBeInTheDocument();
    fireEvent.click(settingsButton!);
    expect(screen.getByTestId('current-path')).toHaveTextContent('/settings');
    expect(screen.queryByTitle('Minimize')).not.toBeInTheDocument();
    expect(invokeIpcMock).not.toHaveBeenCalled();
  });

  it('renders custom controls on Windows', async () => {
    window.electron.platform = 'win32';
    render(
      <MemoryRouter>
        <TitleBar />
      </MemoryRouter>,
    );

    expect(screen.getByTitle('Minimize')).toBeInTheDocument();
    expect(screen.getByTitle('Maximize')).toBeInTheDocument();
    expect(screen.getByTitle('Close')).toBeInTheDocument();
    await waitFor(() => {
      expect(invokeIpcMock).toHaveBeenCalledWith('window:isMaximized');
    });
  });

  it('does not render custom title bar on Linux', () => {
    window.electron.platform = 'linux';
    const { container } = render(
      <MemoryRouter>
        <TitleBar />
      </MemoryRouter>,
    );
    expect(container.firstChild).toBeNull();
    expect(screen.queryByTitle('Minimize')).not.toBeInTheDocument();
    expect(invokeIpcMock).not.toHaveBeenCalled();
  });
});
