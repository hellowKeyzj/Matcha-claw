import { app } from 'electron';
import { access, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { PluginLoad } from './protocol';
import { AppPluginProcess } from './runtime-process';
import { AppPluginRuntimeStartupError, capturePluginLog, within, type AppPluginRuntimeCallbacks } from './runtime';

async function exists(path: string): Promise<boolean> {
  try { await access(path); return true; }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false; throw error; }
}

export function pluginProcessEnvironment(): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = {};
  // Runtime credentials are never a plugin capability. Model calls use the private Host callback.
  for (const name of ['PATH', 'Path', 'SystemRoot', 'WINDIR', 'TEMP', 'TMP', 'HOME', 'USERPROFILE', 'LOCALAPPDATA', 'APPDATA', 'LANG', 'LC_ALL', 'SSL_CERT_FILE', 'SSL_CERT_DIR']) {
    if (process.env[name] !== undefined) environment[name] = process.env[name];
  }
  return environment;
}

export async function preparePluginPython(load: PluginLoad, callbacks: AppPluginRuntimeCallbacks, signal: AbortSignal): Promise<string> {
  const backend = load.manifest.backend;
  if (backend?.language !== 'python' || backend.pythonVersion !== '3.12') throw new Error('App plugins require Python 3.12.');
  const hasProject = await exists(join(load.packagePath, 'pyproject.toml'));
  if (hasProject !== await exists(join(load.packagePath, 'uv.lock'))) throw new Error('Python app plugins must include both pyproject.toml and uv.lock, or neither.');
  const environmentPath = join(load.storagePath, '.python', load.digest);
  const python = join(environmentPath, process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python');
  const marker = join(environmentPath, '.matcha-ready');
  if (await exists(python) && await exists(marker) && await readFile(marker, 'utf8') === load.digest) return python;
  signal.throwIfAborted();
  const uv = app.isPackaged ? join(process.resourcesPath, 'bin', process.platform === 'win32' ? 'uv.exe' : 'uv')
    : join(app.getAppPath(), 'resources', 'bin', `${process.platform}-${process.arch}`, process.platform === 'win32' ? 'uv.exe' : 'uv');
  if (!await exists(uv)) throw new Error('The bundled uv executable is unavailable. Repair the Matcha installation before starting this Python plugin.');
  await mkdir(join(load.storagePath, '.python'), { recursive: true, mode: 0o700 });
  // A failed preparation owns no running backend; never reuse a partial environment.
  await rm(environmentPath, { recursive: true, force: true });
  const env = { ...pluginProcessEnvironment(), UV_PROJECT_ENVIRONMENT: environmentPath, UV_NO_PROGRESS: '1' };
  const run = async (args: string[]) => {
    signal.throwIfAborted();
    const owned = await AppPluginProcess.launch(uv, args, load.storagePath, env);
    capturePluginLog(owned.child.stdout, 'info', callbacks.log);
    capturePluginLog(owned.child.stderr, 'error', callbacks.log);
    let cancel = () => undefined as void;
    const cancelled = new Promise<never>((_, reject) => { cancel = () => reject(signal.reason); });
    signal.addEventListener('abort', cancel, { once: true });
    if (signal.aborted) cancel();
    try { await within(Promise.race([owned.wait(), cancelled]), 180_000, 'Python dependency preparation timed out. Check Python 3.12 availability and the locked dependency cache.'); signal.throwIfAborted(); }
    catch (error) {
      try { await owned.forceClose(); }
      catch (cleanupError) {
        throw new AppPluginRuntimeStartupError(new AggregateError([error, cleanupError]), {
          call: async () => { throw new Error('Python dependency preparation did not finish. Stop the owned process before retrying.'); },
          close: () => owned.forceClose(), forceClose: () => owned.forceClose(),
        });
      }
      throw error;
    }
    finally { signal.removeEventListener('abort', cancel); }
  };
  callbacks.log('info', 'Preparing the plugin-owned Python 3.12 environment; first use may download Python and locked dependencies.');
  await run(['venv', '--python', '3.12', environmentPath]);
  if (hasProject) await run(['sync', '--locked', '--no-dev', '--no-build', '--no-install-project', '--no-editable', '--python', python, '--project', load.packagePath]);
  await writeFile(marker, load.digest, { mode: 0o600 });
  return python;
}
