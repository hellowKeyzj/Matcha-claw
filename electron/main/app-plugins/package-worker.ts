import { isMarkedAsUntransferable, parentPort, type MessagePort } from 'node:worker_threads';
import type { PackageReply, PackageRequest, PackageWorkerRequest } from './package-contract';
import { AppPluginError, buildAppPluginPackage, decodeAppPluginPackage, readAppPluginPackage, verifyAppPluginPackageDigest } from './package';

const port = parentPort;
if (!port) throw new Error('App plugin package worker requires its parent port.');

async function run(request: PackageRequest, port: MessagePort): Promise<void> {
  const transfers = new Set<ArrayBuffer>();
  const transfer = (bytes: Uint8Array): Uint8Array => {
    // Node's small Buffer pool cannot transfer ownership and must not cross this boundary.
    const owned = bytes.buffer instanceof ArrayBuffer && !isMarkedAsUntransferable(bytes.buffer) ? bytes : new Uint8Array(bytes);
    if (owned.buffer instanceof ArrayBuffer) transfers.add(owned.buffer);
    return owned;
  };
  let reply: PackageReply;
  try {
    if (request.operation === 'verify') {
      const bytes = Buffer.from(request.bytes.buffer, request.bytes.byteOffset, request.bytes.byteLength);
      verifyAppPluginPackageDigest(bytes, request.expectedDigest);
      reply = { ok: true, operation: 'verify', result: transfer(bytes) };
    } else {
      const contents = request.operation === 'inspect' || request.operation === 'import' ? await decodeAppPluginPackage(request.packageBase64)
        : request.operation === 'build' ? await buildAppPluginPackage(request.input)
          : await readAppPluginPackage(Buffer.from(request.bytes.buffer, request.bytes.byteOffset, request.bytes.byteLength),
            request.operation === 'validate' ? undefined : request.expectedDigest);
      const { manifest, digest } = contents;
      if ('expectedManifest' in request && JSON.stringify(manifest) !== JSON.stringify(request.expectedManifest)) {
        throw new Error('Installed app plugin manifest does not match its package.');
      }
      switch (request.operation) {
        case 'inspect': case 'read': reply = { ok: true, operation: request.operation, result: { manifest, digest } }; break;
        case 'import': reply = { ok: true, operation: 'import', result: { manifest, digest, bytes: transfer(contents.bytes) } }; break;
        case 'build': reply = { ok: true, operation: 'build', result: { manifest, digest, packageBase64: contents.bytes.toString('base64') } }; break;
        case 'files': reply = { ok: true, operation: 'files', result: { manifest, digest, files: new Map([...contents.files].map(([name, bytes]) => [name, transfer(bytes)])) } }; break;
        case 'validate': reply = { ok: true, operation: 'validate', result: {
          manifest, digest, bytes: transfer(contents.bytes),
          files: new Map([...contents.files].map(([name, bytes]) => [name, transfer(bytes)])),
        } }; break;
        case 'html': {
          const bytes = contents.files.get(request.entry);
          if (!bytes) throw new Error('App plugin HTML entry is missing.');
          reply = { ok: true, operation: 'html', result: { manifest, html: Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString('utf8') } };
          break;
        }
      }
    }
  } catch (error) {
    reply = error instanceof AppPluginError
      ? { ok: false, code: error.code, message: error.message }
      : { ok: false, message: 'App plugin package processing failed.' };
  }
  port.postMessage(reply, [...transfers]);
}

port.on('message', (request: PackageWorkerRequest) => {
  if (request.operation === 'close') port.close();
  else void run(request, port);
});
