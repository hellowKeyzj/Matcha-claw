import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import ts from 'typescript';
import { getOpenClawSafeDeleteSource, patchOpenClawWorkerFilesystemSource } from './openclaw-filesystem-patches.mjs';

const require = createRequire(import.meta.url);
const tar = require('tar');
const digest = value => createHash('sha256').update(value).digest('hex');
const STAMP = '// matcha-native-world-worker-v1 sha256=';
const STORAGE_STAMP = '// matcha-native-world-storage-v1 sha256=';
const printer = ts.createPrinter({ newLine: ts.NewLineKind.LineFeed });

// These helpers run inside the existing native transaction and custody owner, never a second owner.
const STORAGE = String.raw`
function matchaWorldHasColumn(database) {
  return database.db.prepare("PRAGMA table_info(session_pending_inputs)").all().some(column => column.name === "world_investigation_json");
}
function matchaWorldStagePendingInput(database, input, receipt) {
  if (input.kind !== "stage" || input.worldInvestigationJson == null) return;
  if (!matchaWorldHasColumn(database)) database.db.exec("ALTER TABLE session_pending_inputs ADD COLUMN world_investigation_json TEXT");
  const world = JSON.parse(input.worldInvestigationJson);
  const row = database.db.prepare("SELECT * FROM session_pending_inputs WHERE input_id = ?").get(input.inputId);
  if (!row || row.run_id !== input.runId || row.session_key !== input.sessionKey || row.session_id !== input.sessionId || row.idempotency_key !== input.idempotencyKey || row.request_hash !== input.requestHash || row.lifecycle_generation !== input.lifecycleGeneration || row.message_json !== input.messageJson || world.acceptedParams.idempotencyKey !== input.runId || world.acceptedParams.sessionKey !== input.sessionKey || world.acceptedParams.sessionId !== input.sessionId || row.world_investigation_json != null && row.world_investigation_json !== input.worldInvestigationJson) throw new Error("World investigation staging custody changed");
  const result = database.db.prepare("UPDATE session_pending_inputs SET world_investigation_json = ? WHERE input_id = ? AND world_investigation_json IS NULL").run(input.worldInvestigationJson, input.inputId);
  if (row.world_investigation_json == null && Number(result.changes) !== 1) throw new Error("World investigation staging did not commit its exact input");
  receipt.worldInvestigationJson = input.worldInvestigationJson;
  receipt.inputId = input.inputId;
}
function matchaWorldPromotePendingInput(database, pending, anchor, owner) {
  if (!matchaWorldHasColumn(database)) return false;
  const row = database.db.prepare("SELECT * FROM session_pending_inputs WHERE input_id = ?").get(pending.inputId);
  if (!row?.world_investigation_json) return false;
  const receipt = JSON.parse(row.world_investigation_json);
  if (!owner || owner.sources || !owner.matchaWorld || !anchor || anchor.entryId !== row.input_id || anchor.sessionId !== row.session_id || anchor.agentId !== owner.agentId || owner.inputId !== row.input_id || owner.sessionId !== row.session_id || owner.sessionKey !== row.session_key || owner.idempotencyKey !== row.idempotency_key || owner.messageJson !== row.message_json || owner.lifecycleGeneration !== row.lifecycle_generation || owner.matchaWorld.nativeInstanceId !== String(row.lifecycle_generation) || owner.matchaWorld.requestDigest !== receipt.requestDigest || receipt.acceptedParams.idempotencyKey !== row.run_id || row.consumed_event_id != null && row.consumed_event_id !== anchor.entryId) throw new Error("World investigation promotion custody changed");
  if (row.consumed_event_id != null) return true;
  receipt.transcriptAnchor = { agentId: anchor.agentId, sessionId: anchor.sessionId, entryId: anchor.entryId };
  receipt.nativeInstanceId = owner.matchaWorld.nativeInstanceId;
  const changed = database.db.prepare("UPDATE session_pending_inputs SET consumed_event_id = ?, world_investigation_json = ? WHERE input_id = ? AND world_investigation_json = ? AND consumed_event_id IS NULL").run(anchor.entryId, JSON.stringify(receipt), row.input_id, row.world_investigation_json);
  if (Number(changed.changes) !== 1) throw new Error("World investigation promotion receipt conflicted");
  return true;
}
function matchaWorldRetainedConsumption(row, owner) {
  return !!(row?.world_investigation_json && owner && !owner.sources && owner.matchaWorld && row.input_id === owner.inputId && row.consumed_event_id === row.input_id && row.message_json === owner.messageJson && row.lifecycle_generation === owner.lifecycleGeneration && JSON.parse(row.world_investigation_json).requestDigest === owner.matchaWorld.requestDigest);
}
function matchaWorldCompletionRetained(database, scope) {
  return matchaWorldHasColumn(database) && !!database.db.prepare("SELECT 1 FROM session_pending_inputs WHERE session_key = ? AND session_id = ? AND idempotency_key = ? AND run_id = ? AND request_hash = ? AND lifecycle_generation = ? AND world_investigation_json IS NOT NULL").get(scope.sessionKey, scope.sessionId, scope.idempotencyKey, scope.runId, scope.requestHash, scope.lifecycleGeneration);
}
function matchaWorldAssertRetained(database, sessionKey, sessionId) {
  if (!matchaWorldHasColumn(database)) return;
  const rows = sessionId === undefined
    ? database.db.prepare("SELECT world_investigation_json FROM session_pending_inputs WHERE session_key = ? AND world_investigation_json IS NOT NULL").all(sessionKey)
    : database.db.prepare("SELECT world_investigation_json FROM session_pending_inputs WHERE session_id = ? AND world_investigation_json IS NOT NULL").all(sessionId);
  if (rows.some(row => JSON.parse(row.world_investigation_json).settledAtMs == null)) throw new Error("World investigation input is not settled");
}
`;

function expression(text) {
  const node = ts.createSourceFile('expression.js', `(${text});`, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS).statements[0].expression.expression;
  const synthesize = current => { ts.setTextRange(current, { pos: -1, end: -1 }); ts.forEachChild(current, synthesize); };
  synthesize(node);
  return node;
}

function rewriteFunction(node, sourceFile) {
  const name = node.name.text;
  if (node.getText(sourceFile).includes('/* matcha-world-custody-v1 */')) throw new Error(`World worker: unsealed custody function ${name}`);
  const text = value => value.getText(sourceFile);
  const params = node.parameters.map(parameter => text(parameter.name));
  const [database, input] = params;
  let changes = 0;
  let prefix = '';
  let extraParameter = false;
  const variables = [];
  const collect = current => { if (ts.isVariableDeclaration(current)) variables.push(current); ts.forEachChild(current, collect); };
  collect(node.body);
  const custodyOwner = () => variables.find(value => value.initializer && /\.current\.getStore\(\)$/.test(text(value.initializer)))?.name.getText(sourceFile);
  let row;
  let owner;
  let anchors;
  if (name === 'resolveSessionPendingInputAppend') {
    owner = custodyOwner();
    row = variables.find(value => value.initializer && ts.isCallExpression(value.initializer) && value.initializer.arguments.length === 3 && text(value.initializer.arguments[0]) === database)?.name.getText(sourceFile);
    if (!owner || !row) throw new Error(`World worker: missing ${name} custody variables`);
  }
  if (name === 'appendTranscriptMessageInTransaction') {
    const pending = variables[0]?.name.getText(sourceFile);
    const existingAnchor = variables.find(value => value.initializer && ts.isCallExpression(value.initializer) && text(value.initializer.expression) === 'readAnchor')?.name.getText(sourceFile);
    const freshAnchor = variables.flatMap(value => ts.isObjectBindingPattern(value.name) ? value.name.elements.filter(item => (item.propertyName ?? item.name).getText(sourceFile) === 'anchor').map(item => item.name.getText(sourceFile)) : [])[0];
    if (!pending || !existingAnchor || !freshAnchor) throw new Error('World worker: missing native transcript anchors');
    anchors = { pending, existingAnchor, freshAnchor };
  }
  const transformed = ts.transform(node, [context => {
    const visit = current => {
      if (name === 'mutatePendingInput' && ts.isCallExpression(current) && text(current.expression) === params[2] && current.arguments.length === 2) {
        changes++;
        return expression(`(matchaWorldStagePendingInput(${text(current.arguments[0]).replace(/\.db$/, '')}, ${database}, ${text(current.arguments[1])}), ${text(current)})`);
      }
      if (name === 'consumeSessionPendingInput' && ts.isCallExpression(current) && current.arguments.some(argument => text(argument).includes('.deleteFrom(')) && text(current).includes('session_pending_inputs')) {
        changes++;
        return expression(`(matchaWorldPromotePendingInput(${database}, ${input}, matchaAnchor, ${custodyOwner()}) ? { numAffectedRows: 1n } : ${text(current)})`);
      }
      if (name === 'appendTranscriptMessageInTransaction' && ts.isCallExpression(current) && current.arguments.length === 2 && text(current.arguments[0]) === database && text(current.arguments[1]) === anchors.pending) {
        changes++;
        return ts.factory.updateCallExpression(current, current.expression, current.typeArguments, [...current.arguments, expression(changes === 1 ? anchors.existingAnchor : anchors.freshAnchor)]);
      }
      if (name === 'resolveSessionPendingInputAppend') {
        if (ts.isBinaryExpression(current) && text(current.left) === `${row}.consumed_event_id` && text(current.right) === 'null') {
          changes++;
          return expression(`(${text(current)} && !matchaWorldRetainedConsumption(${row}, ${owner}))`);
        }
        if (ts.isBinaryExpression(current) && text(current.left) === `${row}.state` && /["'`]queued["'`]/.test(text(current.right))) {
          changes++;
          return expression(`(${text(current)} && !matchaWorldRetainedConsumption(${row}, ${owner}))`);
        }
        if (ts.isCallExpression(current) && text(current.expression) === 'assertPendingInputOwnerCurrent' && current.arguments.length === 1 && text(current.arguments[0]) === owner) {
          changes++;
          return expression(`(!matchaWorldRetainedConsumption(${row}, ${owner}) && ${text(current)})`);
        }
        if (ts.isPropertyAssignment(current) && text(current.name) === 'alreadyPromoted' && text(current.initializer) === `!${row}`) {
          changes++;
          return ts.factory.updatePropertyAssignment(current, current.name, expression(`!${row} || matchaWorldRetainedConsumption(${row}, ${owner})`));
        }
      }
      if (name === 'captureSessionPendingInputWorkerCustody' && ts.isObjectLiteralExpression(current) && current.properties.some(property => ts.isPropertyAssignment(property) && text(property.name) === 'messageJson')) {
        const message = current.properties.find(property => ts.isPropertyAssignment(property) && text(property.name) === 'messageJson');
        const captured = text(message.initializer).replace(/\.messageJson$/, '');
        changes++;
        return ts.factory.updateObjectLiteralExpression(current, [...current.properties, ts.factory.createPropertyAssignment('matchaWorld', expression(`${captured}.matchaWorld`))]);
      }
      if (name === 'writeSessionInputCompletion' && ts.isCallExpression(current) && current.arguments.some(argument => text(argument).includes('.deleteFrom(')) && text(current).includes('session_pending_inputs')) {
        changes++;
        return expression(`(!matchaWorldCompletionRetained(${database}, ${input}) && ${text(current)})`);
      }
      return ts.visitEachChild(current, visit, context);
    };
    return current => ts.visitNode(current, visit);
  }]);
  try {
    ts.setEmitFlags(transformed.transformed[0], ts.EmitFlags.NoLeadingComments);
    let result = printer.printNode(ts.EmitHint.Unspecified, transformed.transformed[0], sourceFile);
    if (name === 'deleteSessionEntryRows' || name === 'deleteSessionPendingInputs') prefix = `matchaWorldAssertRetained(${database}, ${input});`;
    if (name === 'deleteSqliteSessionStateRows') prefix = `matchaWorldAssertRetained(${database}, undefined, ${input});`;
    if (name === 'deleteLegacySessionEntryRows') prefix = `for (const key of ${input}) matchaWorldAssertRetained(${database}, key);`;
    if (name === 'consumeSessionPendingInput') extraParameter = true;
    const expected = { mutatePendingInput: 1, consumeSessionPendingInput: 1, appendTranscriptMessageInTransaction: 2, resolveSessionPendingInputAppend: 5, captureSessionPendingInputWorkerCustody: 1, writeSessionInputCompletion: 1 }[name] ?? 0;
    if (changes !== expected) throw new Error(`World worker: ${name} expected ${expected} edits, found ${changes}`);
    if (extraParameter) result = result.replace(/^(function consumeSessionPendingInput\([^)]*)(\))/, '$1, matchaAnchor$2');
    const body = result.indexOf('{', result.indexOf(')'));
    return `${result.slice(0, body + 1)}\n/* matcha-world-custody-v1 */\n${prefix}\n${result.slice(body + 1)}`;
  } finally { transformed.dispose(); }
}

export function patchWorldStorageSource(source, names) {
  if (source.startsWith(STORAGE_STAMP)) {
    const newline = source.indexOf('\n');
    if (digest(source.slice(newline + 1)) !== source.slice(STORAGE_STAMP.length, newline)) throw new Error('World worker: sealed storage drift');
    return source;
  }
  const sourceFile = ts.createSourceFile('world-storage.js', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
  if (sourceFile.parseDiagnostics.length) throw new Error('World worker: invalid storage source');
  const functions = [];
  const visit = node => { if (ts.isFunctionDeclaration(node) && names.includes(node.name?.text)) functions.push(node); ts.forEachChild(node, visit); };
  visit(sourceFile);
  if (functions.length !== names.length || names.some(name => functions.filter(node => node.name.text === name).length !== 1)) throw new Error(`World worker: expected unique storage functions: ${names.join(', ')}`);
  let result = source;
  for (const node of functions.sort((left, right) => right.getStart(sourceFile) - left.getStart(sourceFile))) result = result.slice(0, node.getStart(sourceFile)) + rewriteFunction(node, sourceFile) + result.slice(node.end);
  result = `${result}\n${STORAGE}`;
  if (ts.createSourceFile('world-storage.js', result, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS).parseDiagnostics.length) throw new Error('World worker: generated invalid storage source');
  return `${STORAGE_STAMP}${digest(result)}\n${result}`;
}

const WORKER_FUNCTIONS = {
  'sqlite-store.worker.mjs': ['mutatePendingInput', 'captureSessionPendingInputWorkerCustody', 'writeSessionInputCompletion', 'resolveSessionPendingInputAppend', 'consumeSessionPendingInput', 'deleteSessionPendingInputs', 'deleteSqliteSessionStateRows', 'appendTranscriptMessageInTransaction', 'deleteSessionEntryRows', 'deleteLegacySessionEntryRows'],
  'worker-chunk-CsDFjM8-.mjs': ['mutatePendingInput'],
  'worker-chunk-D9KQSKAT.mjs': ['captureSessionPendingInputWorkerCustody', 'writeSessionInputCompletion', 'resolveSessionPendingInputAppend', 'consumeSessionPendingInput', 'deleteSessionPendingInputs'],
  'worker-chunk-DndI5zi9.mjs': ['deleteSqliteSessionStateRows'],
  'worker-chunk-s8Z6_lfJ.mjs': ['appendTranscriptMessageInTransaction'],
  'worker-chunk-CEjuXxto.mjs': ['deleteSessionEntryRows', 'deleteLegacySessionEntryRows']
};

function manifest(directory) {
  return fs.readdirSync(directory).sort().map(file => {
    if (!/^(?:[a-z0-9][a-z0-9.-]*|worker-chunk-[A-Za-z0-9_-]+)\.mjs$/.test(file) || !fs.lstatSync(path.join(directory, file)).isFile()) throw new Error(`World worker: invalid artifact ${file}`);
    const bytes = fs.readFileSync(path.join(directory, file));
    return { path: file, mode: 0o700, size: bytes.length, sha256: digest(bytes) };
  });
}
function manifestHash(entries) {
  return digest(`openclaw-worker-bundle-v1\0${entries.map(entry => `${entry.path}\0${entry.mode.toString(8)}\0${entry.size}\0${entry.sha256}\0`).join('')}`);
}

export function prepareWorldWorkerArchive(openclawDir) {
  const directory = path.join(openclawDir, 'dist', 'worker-artifacts');
  const files = fs.readdirSync(directory);
  if (fs.existsSync(path.join(openclawDir, 'dist', 'worker')) || files.length !== 1 || !/^[a-f0-9]{64}\.tar\.gz$/.test(files[0]) || !fs.lstatSync(path.join(directory, files[0])).isFile()) throw new Error('World worker: expected one native packaged archive and no dist/worker');
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'matcha-world-worker-'));
  try {
    const extracted = path.join(temporary, 'extracted');
    fs.mkdirSync(extracted);
    const archive = path.join(directory, files[0]);
    const oldPath = `dist/worker-artifacts/${files[0]}`;
    const originalBytes = fs.readFileSync(archive);
    const inventories = new Map();
    for (const inventory of ['postinstall-inventory.json', 'postinstall-content-inventory.json']) {
      const location = path.join(openclawDir, 'dist', inventory);
      const values = JSON.parse(fs.readFileSync(location, 'utf8'));
      const matches = values.filter(value => (typeof value === 'string' ? value : value.path).startsWith('dist/worker-artifacts/'));
      if (matches.length !== 1 || (typeof matches[0] === 'string' ? matches[0] : matches[0].path) !== oldPath || typeof matches[0] !== 'string' && (matches[0].sha256 !== digest(originalBytes) || matches[0].size !== originalBytes.length)) throw new Error(`World worker: inconsistent ${inventory} entry`);
      inventories.set(location, values);
    }
    const paths = new Set();
    tar.t({ file: archive, sync: true, strict: true, onentry(entry) {
      if (entry.type !== 'File' || !/^[A-Za-z0-9_.-]+\.mjs$/.test(entry.path) || paths.has(entry.path) || entry.mode !== 0o700) throw new Error('World worker: invalid native archive entry');
      paths.add(entry.path);
    } });
    tar.x({ file: archive, cwd: extracted, sync: true, strict: true, preservePaths: false, noMtime: true });
    if (manifestHash(manifest(extracted)) !== files[0].slice(0, -7)) throw new Error('World worker: native archive manifest hash mismatch');
    let changed = false;
    const helperPath = path.join(extracted, 'worker-chunk-MatchaSafeDelete.mjs');
    const helper = getOpenClawSafeDeleteSource();
    if (fs.existsSync(helperPath)) {
      if (fs.readFileSync(helperPath, 'utf8') !== helper) throw new Error('World worker: safe-delete helper drift');
    } else {
      fs.writeFileSync(helperPath, helper);
      changed = true;
    }
    const targets = new Set([...Object.keys(WORKER_FUNCTIONS), 'worker-chunk-CvXFaEh9.mjs', 'worker-chunk-De0GZxJP.mjs']);
    for (const file of targets) {
      const location = path.join(extracted, file);
      const source = fs.readFileSync(location, 'utf8');
      if (source.startsWith(STAMP)) {
        const newline = source.indexOf('\n');
        if (digest(source.slice(newline + 1)) !== source.slice(STAMP.length, newline)) throw new Error(`World worker: sealed artifact drift ${file}`);
        continue;
      }
      let next = patchOpenClawWorkerFilesystemSource(file, source);
      if (WORKER_FUNCTIONS[file]) next = patchWorldStorageSource(next, WORKER_FUNCTIONS[file]);
      fs.writeFileSync(location, `${STAMP}${digest(next)}\n${next}`);
      changed = true;
    }
    if (!changed) return { updates: new Map(), changed: false };
    const entries = manifest(extracted);
    const nextName = `${manifestHash(entries)}.tar.gz`;
    const packed = path.join(temporary, nextName);
    tar.c({ cwd: extracted, file: packed, sync: true, gzip: true, noDirRecurse: true, noMtime: true, portable: true, filter(_path, stat) { stat.mode = 0o100700; return true; } }, entries.map(entry => entry.path));
    const packedEntries = [];
    tar.t({ file: packed, sync: true, strict: true, onentry(entry) {
      if (entry.type !== 'File' || entry.mode !== 0o700) throw new Error('World worker: repacked entry mode changed');
      packedEntries.push({ path: entry.path, mode: entry.mode, size: entry.size });
    } });
    if (JSON.stringify(packedEntries) !== JSON.stringify(entries.map(({ path, mode, size }) => ({ path, mode, size })))) throw new Error('World worker: repacked entries changed');
    const verified = path.join(temporary, 'verified');
    fs.mkdirSync(verified);
    tar.x({ file: packed, cwd: verified, sync: true, strict: true, preservePaths: false, noMtime: true });
    if (manifestHash(manifest(verified)) !== nextName.slice(0, -7)) throw new Error('World worker: repacked manifest hash mismatch');
    const bytes = fs.readFileSync(packed);
    const nextPath = `dist/worker-artifacts/${nextName}`;
    const updates = new Map([[path.join(directory, nextName), bytes]]);
    for (const [location, values] of inventories) {
      const next = values.map(value => value === oldPath ? nextPath : value.path === oldPath ? { ...value, path: nextPath, sha256: digest(bytes), size: bytes.length } : value);
      updates.set(location, `${JSON.stringify(next, null, 2)}\n`);
    }
    return { updates, changed: true, obsolete: archive };
  } finally { fs.rmSync(temporary, { recursive: true, force: true }); }
}
