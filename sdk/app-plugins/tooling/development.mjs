import { readFile } from 'node:fs/promises';

const MAX_JSON_BYTES = 64 * 1024;
const MAX_CALL_BYTES = 128 * 1024 * 1024;

export async function readDevelopmentConnection(path) {
  if (!path) throw new Error('Provide --connection <connection.json> from app_plugins_sdk.');
  const bytes = await readFile(path);
  if (bytes.length > MAX_JSON_BYTES) throw new Error('Development connection file is too large.');
  let input;
  try { input = JSON.parse(bytes.toString('utf8')); } catch { throw new Error('Development connection file must contain valid JSON.'); }
  const connection = input?.development ?? input;
  if (!connection || typeof connection !== 'object' || Array.isArray(connection)
    || Object.keys(connection).some((key) => !['developmentId', 'baseUrl', 'token'].includes(key))
    || typeof connection.developmentId !== 'string' || !/^[A-Za-z0-9_-]{1,160}$/.test(connection.developmentId)
    || typeof connection.baseUrl !== 'string'
    || typeof connection.token !== 'string' || !/^[A-Za-z0-9_-]{16,512}$/.test(connection.token)) {
    throw new Error('Invalid development connection; use the development object returned by app_plugins_sdk.');
  }
  let url;
  try { url = new URL(connection.baseUrl); } catch { throw new Error('Invalid development baseUrl.'); }
  if (url.protocol !== 'http:' || !['127.0.0.1', '[::1]'].includes(url.hostname) || !url.port || url.username || url.password || url.search || url.hash
    || url.pathname !== `/development/${connection.developmentId}`) throw new Error('Development baseUrl must be the development-specific loopback endpoint.');
  return { developmentId: connection.developmentId, token: connection.token, baseUrl: url.href };
}

export async function developmentRequest(connection, operation, { method = 'GET', json, bytes, signal } = {}) {
  if (!['', 'package', 'status', 'preview', 'inspect', 'act', 'call', 'install'].includes(operation)) throw new Error('Unsupported development operation.');
  const body = bytes ?? (json === undefined ? undefined : JSON.stringify(json));
  const limit = operation === 'package' ? (await import('../dist/package.js')).MAX_APP_PLUGIN_ZIP_BYTES : operation === 'call' ? MAX_CALL_BYTES : MAX_JSON_BYTES;
  if (body !== undefined && Buffer.byteLength(body) > limit) throw new Error('Development request exceeds its size limit.');
  const timeout = AbortSignal.timeout(operation === 'call' ? 30 * 60 * 1000 : 30_000);
  let response;
  try {
    response = await fetch(`${connection.baseUrl}${operation ? `/${operation}` : ''}`, {
      method, body, redirect: 'error', signal: signal ? AbortSignal.any([timeout, signal]) : timeout,
      headers: { Authorization: `Bearer ${connection.token}`, ...(body === undefined ? {} : { 'Content-Type': bytes ? 'application/zip' : 'application/json' }) },
    });
  } catch (error) {
    if (signal?.aborted) throw signal.reason;
    throw new Error(`Development ${operation || 'stop'} could not reach the Matcha development endpoint.`, { cause: error });
  }
  const chunks = [];
  let length = 0;
  for await (const chunk of response.body ?? []) {
    length += chunk.length;
    if (length > (operation === 'call' ? MAX_CALL_BYTES : 4 * 1024 * 1024)) throw new Error('Development response exceeds its size limit.');
    chunks.push(chunk);
  }
  const text = Buffer.concat(chunks).toString('utf8').replaceAll(connection.token, '[redacted]');
  if (!response.ok) throw new Error(`Development ${operation || 'stop'} was rejected (HTTP ${response.status}).${text ? ` ${text.slice(0, 1000)}` : ''}`);
  if (!text) return null;
  try { return JSON.parse(text); } catch { throw new Error('Matcha returned an invalid development response.'); }
}
