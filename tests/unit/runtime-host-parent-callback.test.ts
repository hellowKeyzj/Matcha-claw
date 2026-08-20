import { afterEach, describe, expect, it, vi } from 'vitest';
import { HostEventBus } from '../../electron/api/event-bus';
import { createParentCallbackReceiver } from '../../electron/main/runtime-host-delivery/parent-callback';

const receivers: Array<{ close: () => Promise<void> }> = [];

afterEach(async () => {
  await Promise.all(receivers.splice(0).map((receiver) => receiver.close()));
});

describe('runtime-host parent callback receiver', () => {
  it('accepts allowlisted gateway and runtime-job events on loopback', async () => {
    const emit = vi.fn();
    const receiver = await createParentCallbackReceiver({ emit } as never);
    receivers.push(receiver);

    const headers = {
      'content-type': 'application/json',
      'x-runtime-host-dispatch-token': receiver.dispatchToken,
    };
    const gatewayResponse = await fetch(`${receiver.baseUrl}/internal/runtime-host/gateway-events`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ version: 1, eventName: 'session:update', payload: { id: 's1' } }),
    });
    const jobResponse = await fetch(`${receiver.baseUrl}/internal/runtime-host/runtime-jobs`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ version: 1, eventName: 'runtime-job:progress', payload: { id: 'j1' } }),
    });

    expect(gatewayResponse.status).toBe(200);
    expect(jobResponse.status).toBe(200);
    expect(emit).toHaveBeenNthCalledWith(1, 'session:update', { id: 's1' });
    expect(emit).toHaveBeenNthCalledWith(2, 'runtime-job:progress', { id: 'j1' });
  });

  it('projects runtime-job events to subscribers and supports unsubscribe', async () => {
    const eventBus = new HostEventBus();
    const progress = vi.fn();
    const done = vi.fn();
    const unsubscribeProgress = eventBus.on('runtime-job:progress', progress);
    eventBus.on('runtime-job:done', done);
    const receiver = await createParentCallbackReceiver(eventBus);
    receivers.push(receiver);

    const headers = {
      'content-type': 'application/json',
      'x-runtime-host-dispatch-token': receiver.dispatchToken,
    };
    const post = (eventName: string, payload: unknown) => fetch(
      `${receiver.baseUrl}/internal/runtime-host/runtime-jobs`,
      {
        method: 'POST',
        headers,
        body: JSON.stringify({ version: 1, eventName, payload }),
      },
    );

    await expect(post('runtime-job:progress', { id: 'j1', percent: 10 }))
      .resolves.toHaveProperty('status', 200);
    unsubscribeProgress();
    await expect(post('runtime-job:progress', { id: 'j1', percent: 20 }))
      .resolves.toHaveProperty('status', 200);
    await expect(post('runtime-job:done', { id: 'j1' }))
      .resolves.toHaveProperty('status', 200);

    expect(progress).toHaveBeenCalledTimes(1);
    expect(progress).toHaveBeenCalledWith({ id: 'j1', percent: 10 });
    expect(done).toHaveBeenCalledWith({ id: 'j1' });
  });

  it('isolates listener failures from callback delivery', async () => {
    const eventBus = new HostEventBus();
    const received = vi.fn();
    eventBus.on('runtime-job:progress', () => {
      throw new Error('listener failure');
    });
    eventBus.on('runtime-job:progress', received);
    const receiver = await createParentCallbackReceiver(eventBus);
    receivers.push(receiver);

    const response = await fetch(`${receiver.baseUrl}/internal/runtime-host/runtime-jobs`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-runtime-host-dispatch-token': receiver.dispatchToken,
      },
      body: JSON.stringify({ version: 1, eventName: 'runtime-job:progress', payload: { id: 'j2' } }),
    });

    expect(response.status).toBe(200);
    expect(received).toHaveBeenCalledWith({ id: 'j2' });
  });

  it('rejects invalid dispatch and event contracts without emitting', async () => {
    const emit = vi.fn();
    const receiver = await createParentCallbackReceiver({ emit } as never);
    receivers.push(receiver);

    const response = await fetch(`${receiver.baseUrl}/internal/runtime-host/gateway-events`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-runtime-host-dispatch-token': 'wrong' },
      body: JSON.stringify({ version: 1, eventName: 'runtime-job:done', payload: {} }),
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
    await expect(fetch(`${receiver.baseUrl}/internal/runtime-host/runtime-jobs`, {
      method: 'POST',
      headers: validHeaders,
      body: JSON.stringify({ version: 1, eventName: 'session:update', payload: {} }),
    })).resolves.toHaveProperty('status', 400);

    expect(emit).not.toHaveBeenCalled();
  });
});
