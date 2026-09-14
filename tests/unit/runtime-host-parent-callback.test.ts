import { afterEach, describe, expect, it, vi } from 'vitest';

const openPathMock = vi.hoisted(() => vi.fn(async () => ''));

vi.mock('electron', () => ({
  shell: {
    openPath: (pathToOpen: string) => openPathMock(pathToOpen),
  },
}));

import { HostEventBus } from '../../electron/api/event-bus';
import { createParentCallbackReceiver } from '../../electron/main/runtime-host-delivery/parent-callback';

const receivers: Array<{ close: () => Promise<void> }> = [];

afterEach(async () => {
  await Promise.all(receivers.splice(0).map((receiver) => receiver.close()));
  openPathMock.mockReset();
  openPathMock.mockResolvedValue('');
});

describe('runtime-host parent callback receiver', () => {
  it('accepts allowlisted gateway events on loopback', async () => {
    const emit = vi.fn();
    const receiver = await createParentCallbackReceiver({ emit } as never);
    receivers.push(receiver);

    const headers = {
      'content-type': 'application/json',
      'x-runtime-host-dispatch-token': receiver.dispatchToken,
    };
    const response = await fetch(`${receiver.baseUrl}/internal/runtime-host/gateway-events`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ version: 1, eventName: 'session:update', payload: { id: 's1' } }),
    });

    expect(response.status).toBe(200);
    expect(emit).toHaveBeenCalledWith('session:update', { id: 's1' });
  });

  it('isolates listener failures from callback delivery', async () => {
    const eventBus = new HostEventBus();
    const received = vi.fn();
    eventBus.on('session:update', () => {
      throw new Error('listener failure');
    });
    eventBus.on('session:update', received);
    const receiver = await createParentCallbackReceiver(eventBus);
    receivers.push(receiver);

    const response = await fetch(`${receiver.baseUrl}/internal/runtime-host/gateway-events`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-runtime-host-dispatch-token': receiver.dispatchToken,
      },
      body: JSON.stringify({ version: 1, eventName: 'session:update', payload: { id: 's2' } }),
    });

    expect(response.status).toBe(200);
    expect(received).toHaveBeenCalledWith({ id: 's2' });
  });

  it('rejects invalid dispatch and event contracts without emitting', async () => {
    const emit = vi.fn();
    const receiver = await createParentCallbackReceiver({ emit } as never);
    receivers.push(receiver);

    const response = await fetch(`${receiver.baseUrl}/internal/runtime-host/gateway-events`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-runtime-host-dispatch-token': 'wrong' },
      body: JSON.stringify({ version: 1, eventName: 'not:allowed', payload: {} }),
    });

    expect(response.status).toBe(403);
    expect(emit).not.toHaveBeenCalled();
  });

  it('preserves callback protocol validation statuses', async () => {
    const emit = vi.fn();
    const receiver = await createParentCallbackReceiver({ emit } as never);
    receivers.push(receiver);

    const path = `${receiver.baseUrl}/internal/runtime-host/gateway-events`;
    const validHeaders = {
      'content-type': 'application/json',
      'x-runtime-host-dispatch-token': receiver.dispatchToken,
    };
    const request = (init: RequestInit = {}) => fetch(path, {
      method: 'POST',
      headers: validHeaders,
      ...init,
    });

    await expect(fetch(`${receiver.baseUrl}/unknown`, { method: 'POST', headers: validHeaders }))
      .resolves.toHaveProperty('status', 404);
    await expect(fetch(path, { method: 'GET', headers: validHeaders }))
      .resolves.toHaveProperty('status', 405);
    await expect(request({ headers: { ...validHeaders, 'x-runtime-host-dispatch-token': 'wrong' } }))
      .resolves.toHaveProperty('status', 403);
    await expect(request({ headers: { ...validHeaders, 'content-type': 'text/plain' } }))
      .resolves.toHaveProperty('status', 415);
    await expect(request({ body: '{' })).resolves.toHaveProperty('status', 400);
    await expect(request({ body: JSON.stringify({ version: 2, eventName: 'session:update', payload: {} }) }))
      .resolves.toHaveProperty('status', 400);
    await expect(request({ body: JSON.stringify({ version: 1, eventName: 'license:gate-changed', payload: {} }) }))
      .resolves.toHaveProperty('status', 400);
    await expect(request({ body: JSON.stringify({ version: 1, eventName: 'not:allowed', payload: {} }) }))
      .resolves.toHaveProperty('status', 400);

    expect(emit).not.toHaveBeenCalled();
  });

  it('opens absolute shell_open_path payloads', async () => {
    const receiver = await createParentCallbackReceiver({ emit: vi.fn() } as never);
    receivers.push(receiver);

    const response = await fetch(`${receiver.baseUrl}/internal/runtime-host/shell-actions`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-runtime-host-dispatch-token': receiver.dispatchToken,
      },
      body: JSON.stringify({ version: 1, action: 'shell_open_path', payload: { path: '  /tmp/report.txt  ' } }),
    });

    await expect(response.json()).resolves.toEqual({
      version: 1,
      success: true,
      status: 200,
      data: { opened: true },
    });
    expect(response.status).toBe(200);
    expect(openPathMock).toHaveBeenCalledWith('/tmp/report.txt');
  });

  it('returns a shell failure envelope when Electron cannot open a path', async () => {
    openPathMock.mockResolvedValue('failed');
    const receiver = await createParentCallbackReceiver({ emit: vi.fn() } as never);
    receivers.push(receiver);

    const response = await fetch(`${receiver.baseUrl}/internal/runtime-host/shell-actions`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-runtime-host-dispatch-token': receiver.dispatchToken,
      },
      body: JSON.stringify({ version: 1, action: 'shell_open_path', payload: { path: '/tmp/report.txt' } }),
    });

    await expect(response.json()).resolves.toEqual({
      version: 1,
      success: false,
      status: 500,
      error: { code: 'SHELL_OPEN_PATH_FAILED', message: 'Failed to open path.' },
    });
    expect(response.status).toBe(500);
  });

  it('rejects unknown shell actions', async () => {
    const receiver = await createParentCallbackReceiver({ emit: vi.fn() } as never);
    receivers.push(receiver);

    const response = await fetch(`${receiver.baseUrl}/internal/runtime-host/shell-actions`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-runtime-host-dispatch-token': receiver.dispatchToken,
      },
      body: JSON.stringify({ version: 1, action: 'gateway_restart', payload: {} }),
    });

    expect(response.status).toBe(400);
    expect(openPathMock).not.toHaveBeenCalled();
  });

  it('rejects invalid shell_open_path payloads', async () => {
    const receiver = await createParentCallbackReceiver({ emit: vi.fn() } as never);
    receivers.push(receiver);

    const path = `${receiver.baseUrl}/internal/runtime-host/shell-actions`;
    const headers = {
      'content-type': 'application/json',
      'x-runtime-host-dispatch-token': receiver.dispatchToken,
    };
    const request = (payload: unknown) => fetch(path, {
      method: 'POST',
      headers,
      body: JSON.stringify({ version: 1, action: 'shell_open_path', payload }),
    });

    await expect(request({ path: '' })).resolves.toHaveProperty('status', 400);
    await expect(request({ path: 'relative/report.txt' })).resolves.toHaveProperty('status', 400);
    await expect(request({ path: '/tmp/bad\0path' })).resolves.toHaveProperty('status', 400);
    await expect(request({ path: 1 })).resolves.toHaveProperty('status', 400);

    expect(openPathMock).not.toHaveBeenCalled();
  });
});
