#!/usr/bin/env node
import { readFile } from 'node:fs/promises';
import { parseArgs } from 'node:util';

const usage = `matcha-app-plugin init <directory> --id example.plugin [--kind application|reader|connector] [--backend typescript|python|rust]
matcha-app-plugin build [directory] [--connection connection.json]
matcha-app-plugin watch [directory] [--connection connection.json]
matcha-app-plugin dev [directory] --connection connection.json
matcha-app-plugin pack <built-directory> <output.zip>
matcha-app-plugin status|preview|inspect|stop --connection connection.json [--entry <declared-html>]
matcha-app-plugin act --connection connection.json --type click|fill --target <snapshot-id> [--value text]
matcha-app-plugin call --connection connection.json --name <tool> [--arguments '{"key":"value"}'|@file.json]
matcha-app-plugin install --connection connection.json --digest <sha256>`;

async function main() {
  const { values, positionals } = parseArgs({ allowPositionals: true, options: {
    help: { type: 'boolean', short: 'h' }, id: { type: 'string' }, name: { type: 'string' },
    backend: { type: 'string' }, kind: { type: 'string' }, connection: { type: 'string' },
    digest: { type: 'string' }, type: { type: 'string' }, target: { type: 'string' }, value: { type: 'string' }, arguments: { type: 'string' }, entry: { type: 'string' },
  } });
  if (values.help || !positionals.length) { console.log(usage); return; }
  const [command, ...args] = positionals;
  const output = (value) => console.log(JSON.stringify(value));
  if (command === 'init') {
    if (args.length !== 1) throw new Error(usage);
    const { initProject } = await import('./init.mjs');
    output(await initProject(args[0], values));
    return;
  }
  if (command === 'pack') {
    if (args.length !== 2) throw new Error(usage);
    const { packToFile } = await import('./pack.mjs');
    output(await packToFile(...args));
    return;
  }
  const { readDevelopmentConnection, developmentRequest } = await import('./development.mjs');
  const connection = values.connection ? await readDevelopmentConnection(values.connection) : undefined;
  if (['build', 'watch', 'dev'].includes(command)) {
    if (args.length > 1 || (command === 'dev' && !connection)) throw new Error(usage);
    const directory = args[0] ?? process.cwd();
    if (command === 'build') {
      const { buildProject } = await import('./build.mjs');
      const result = await buildProject(directory);
      output({ event: 'built', id: result.manifest.id, digest: result.digest, directory: result.directory });
      if (connection) {
        output(await developmentRequest(connection, 'package', { method: 'POST', bytes: result.bytes }));
        output(await developmentRequest(connection, 'preview', { method: 'POST', json: {} }));
      }
      return;
    }
    const controller = new AbortController();
    const stop = () => controller.abort(new Error('Development watcher stopped.'));
    process.once('SIGINT', stop);
    process.once('SIGTERM', stop);
    try {
      const { watchProject } = await import('./watch.mjs');
      await watchProject(directory, { connection, signal: controller.signal });
    } finally {
      process.removeListener('SIGINT', stop);
      process.removeListener('SIGTERM', stop);
    }
    return;
  }
  if (args.length || !connection) throw new Error(usage);
  switch (command) {
    case 'status': output(await developmentRequest(connection, 'status')); return;
    case 'preview': output(await developmentRequest(connection, 'preview', { method: 'POST', json: {} })); return;
    case 'inspect': output(await developmentRequest(connection, 'inspect', { method: 'POST', json: values.entry ? { entry: values.entry } : {} })); return;
    case 'stop': output(await developmentRequest(connection, '', { method: 'DELETE' })); return;
    case 'install':
      if (!/^[a-f0-9]{64}$/.test(values.digest ?? '')) throw new Error('install requires --digest <sha256> from the latest successful upload.');
      output(await developmentRequest(connection, 'install', { method: 'POST', json: { digest: values.digest } }));
      return;
    case 'act': {
      if (!['click', 'fill'].includes(values.type) || !values.target || (values.type === 'fill' ? values.value === undefined : values.value !== undefined)) throw new Error('act requires --type click|fill and --target from the latest snapshot; fill also requires --value.');
      output(await developmentRequest(connection, 'act', { method: 'POST', json: { type: values.type, id: values.target, ...(values.type === 'fill' ? { value: values.value } : {}), ...(values.entry ? { entry: values.entry } : {}) } }));
      return;
    }
    case 'call': {
      if (!values.name || !/^[A-Za-z0-9_-]{1,64}$/.test(values.name)) throw new Error('call requires a declared local --name.');
      const input = values.arguments ?? '{}';
      const arguments_ = JSON.parse(input.startsWith('@') ? await readFile(input.slice(1), 'utf8') : input);
      if (!arguments_ || typeof arguments_ !== 'object' || Array.isArray(arguments_)) throw new Error('Tool arguments must be a JSON object.');
      output(await developmentRequest(connection, 'call', { method: 'POST', json: { name: values.name, arguments: arguments_ } }));
      return;
    }
    default: throw new Error(usage);
  }
}

main().catch((error) => { console.error(error.message); process.exitCode = 1; });
