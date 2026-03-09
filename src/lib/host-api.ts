const HOST_API_PORT = 3210;
const HOST_API_BASE = `http://127.0.0.1:${HOST_API_PORT}`;

async function parseResponse<T>(response: Response): Promise<T> {
  if (!response.ok) {
    let message = `${response.status} ${response.statusText}`;
    try {
      const payload = await response.json() as { error?: string };
      if (payload?.error) {
        message = payload.error;
      }
    } catch {
      // ignore body parse failure
    }
    throw new Error(message);
  }

  if (response.status === 204) {
    return undefined as T;
  }

  return await response.json() as T;
}

export async function hostApiFetch<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`${HOST_API_BASE}${path}`, {
    ...init,
    headers: {
      'Content-Type': 'application/json',
      ...(init?.headers || {}),
    },
  });
  return parseResponse<T>(response);
}

export function createHostEventSource(path = '/api/events'): EventSource {
  return new EventSource(`${HOST_API_BASE}${path}`);
}

export function getHostApiBase(): string {
  return HOST_API_BASE;
}
