/**
 * Use Electron's network stack when available so requests honor
 * session.defaultSession.setProxy(...). Fall back to the Node global fetch
 * for non-Electron test environments.
 */

export async function proxyAwareFetch(
  input: string | URL,
  init?: RequestInit
): Promise<Response> {
  if (process.versions.electron) {
    const { net } = await import('electron');
    return await net.fetch(input.toString(), init);
  }

  return await fetch(input, init);
}
