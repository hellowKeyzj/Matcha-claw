import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';

const VERSION = '2026.9.3';
const PATCH = 'native-history-path';
const read = (file) => fs.readFileSync(file, 'utf8');
const digest = (source) => createHash('sha256').update(source).digest('hex');

function replace(source, before, after) {
  if (source.split(after).length === 2) return source;
  const anchors = (Array.isArray(before) ? before : [before]).filter((anchor) => source.includes(anchor));
  if (source.includes(after) || anchors.length !== 1 || source.split(anchors[0]).length !== 2) {
    throw new Error(`${PATCH}: source anchor mismatch: ${String(before).slice(0, 100)}`);
  }
  return source.replace(anchors[0], () => after);
}

function sealedTransform(source, transform) {
  const chatStamp = source.match(/^\/\/ native-chat-commentary-replacement sha256=([a-f0-9]{64})\n/);
  let body = chatStamp ? source.slice(chatStamp[0].length) : source;
  if (chatStamp && digest(body) !== chatStamp[1]) throw new Error(`${PATCH}: chat source seal mismatch`);
  const stamp = body.match(/^\/\/ native-history-path sha256=([a-f0-9]{64})\n/);
  if (stamp) {
    body = body.slice(stamp[0].length);
    if (digest(body) !== stamp[1]) throw new Error(`${PATCH}: source seal mismatch`);
  }
  body = transform(body);
  body = `// ${PATCH} sha256=${digest(body)}\n${body}`;
  return chatStamp ? `// native-chat-commentary-replacement sha256=${digest(body)}\n${body}` : body;
}

// All path queries share the page's validated projection transaction.
const pathProjection = `function readHistoryPath(projection, previous) {
	const anchor = {
		sessionId: projection.resolved.sessionId,
		generation: readTranscriptProjectionGeneration(projection) ?? null,
		leafEntryId: projection.state.leafEventId ?? null
	};
	if (previous === void 0) return { anchor };
	const result = (relation) => ({ anchor, previous, relation });
	if (previous.sessionId !== anchor.sessionId || previous.generation === null && previous.leafEntryId !== null || previous.generation !== anchor.generation && !(previous.generation === null && previous.leafEntryId === null)) return result("reset");
	const db = getActiveTranscriptKysely(projection.database);
	const active = () => db.selectFrom("session_transcript_active_events as active")
		.innerJoin("transcript_event_identities as identity", (join) => join.onRef("identity.session_id", "=", "active.session_id").onRef("identity.seq", "=", "active.event_seq"))
		.where("active.session_id", "=", projection.resolved.sessionId);
	const old = previous.leafEntryId === null ? void 0 : executeSqliteQueryTakeFirstSync(projection.database.db, active().select("active.active_position").where("identity.event_id", "=", previous.leafEntryId).limit(1));
	if (previous.leafEntryId !== null && !old) return result("off-path");
	const boundary = executeSqliteQueryTakeFirstSync(projection.database.db, active().select("active.active_position")
		.where("identity.event_type", "in", ["reset", "compaction"])
		.$if(old !== void 0, (query) => query.where("active.active_position", ">", old.active_position)).limit(1));
	if (boundary) return result("reset");
	return result(previous.leafEntryId === anchor.leafEntryId ? "exact" : "ancestor");
}
`;

export function patchHistoryPathReaders(source) {
  return sealedTransform(source, (source) => {
    source = replace(source, 'function readTranscriptDisplayDelta(scope, limits = {}) {', `${pathProjection}function readTranscriptDisplayDelta(scope, limits = {}) {`);
    source = replace(source, '\t\tconst result = readTranscriptRawDelta(scope, readLimits);\n\t\tif (result.kind !== "page") return result;', '\t\tconst historyPath = readHistoryPath(projection, limits.historyAnchor);\n\t\tconst result = readTranscriptRawDelta(scope, readLimits);\n\t\tif (result.kind !== "page") return { ...result, historyPath };');
    source = replace(source, '\t\t\t...result,\n\t\t\tactiveLeafEntryId: projection.state.leafEventId,', '\t\t\t...result,\n\t\t\thistoryPath,\n\t\t\tactiveLeafEntryId: projection.state.leafEventId,');
    source = replace(source, '\t\tconst generation = readTranscriptProjectionGeneration(projection);\n\t\tconst deltaCursor', '\t\tconst historyPath = readHistoryPath(projection, options.historyAnchor);\n\t\tconst generation = historyPath.anchor.generation;\n\t\tconst deltaCursor');
    source = replace(source, '\t\tif (maxMessages === 0 || maxLines === 0) return {\n\t\t\tactiveLeafEntryId: projection.state.leafEventId,', '\t\tif (maxMessages === 0 || maxLines === 0) return {\n\t\t\thistoryPath,\n\t\t\tactiveLeafEntryId: projection.state.leafEventId,');
    source = replace(source, '\t\treturn {\n\t\t\tactiveLeafEntryId: projection.state.leafEventId,\n\t\t\t...deltaCursor', '\t\treturn {\n\t\t\thistoryPath,\n\t\t\tactiveLeafEntryId: projection.state.leafEventId,\n\t\t\t...deltaCursor');
    source = replace(source, '\t\t\tevents: readVisibleHistoryRange(projection, boundedStart, endExclusive, history),', '\t\t\thistoryPath: readHistoryPath(projection, options.historyAnchor),\n\t\t\tevents: readVisibleHistoryRange(projection, boundedStart, endExclusive, history),');
    source = replace(source, '\tconst defaultMaxLines = maxMessages * 20 + 20;\n\treturn {', '\tconst defaultMaxLines = maxMessages * 20 + 20;\n\treturn {\n\t\thistoryAnchor: opts?.historyAnchor,');
    source = replace(source, '\t\t...page.deltaCursor ? { deltaCursor: page.deltaCursor } : {},', '\t\thistoryPath: page.historyPath,\n\t\t...page.deltaCursor ? { deltaCursor: page.deltaCursor } : {},');
    source = replace(source, 'const { activeLeafEntryId, deltaCursor, displaySource, messages, transcriptEvents, totalMessages } = await readRecentSqliteMessageRecords', 'const { activeLeafEntryId, deltaCursor, displaySource, historyPath, messages, transcriptEvents, totalMessages } = await readRecentSqliteMessageRecords');
    source = replace(source, '\tif (totalMessages === 0 && messages.length === 0 && opts.allowResetArchiveFallback === true) return await archivedTranscriptReader(target).readRecentWithStats({\n\t\t...opts,\n\t\tresetArchiveOnly: true\n\t});', '\tif (totalMessages === 0 && messages.length === 0 && opts.allowResetArchiveFallback === true) {\n\t\tconst archived = await archivedTranscriptReader(target).readRecentWithStats({ ...opts, resetArchiveOnly: true });\n\t\tif (archived.transcriptSource !== void 0) return archived;\n\t}');
    source = replace(source, '\t\t...activeLeafEntryId !== void 0 ? { activeLeafEntryId } : {},', '\t\thistoryPath,\n\t\t...activeLeafEntryId !== void 0 ? { activeLeafEntryId } : {},');
    source = replace(source, '\t\t...page.olderOffset !== void 0 ? { olderOffset: page.olderOffset } : {},', '\t\thistoryPath: page.historyPath,\n\t\t...page.olderOffset !== void 0 ? { olderOffset: page.olderOffset } : {},');
    return source;
  });
}

export function patchHistoryPathTail(source) {
  return sealedTransform(source, (source) => {
    source = replace(source, 'const readPage = offset === 0 ? await readRecentSessionMessagesWithStatsAsync(params.readScope, {', 'const readPage = offset === 0 ? await readRecentSessionMessagesWithStatsAsync(params.readScope, {\n\t\thistoryAnchor: params.historyAnchor,');
    source = replace(source, 'if (page.displaySource !== readPage.displaySource) throw new SessionTranscriptProjectionUnavailableError(params.readScope.sessionId);', 'if (page.displaySource !== readPage.displaySource || offset === 0 && (page.historyPath?.anchor.sessionId !== readPage.historyPath?.anchor.sessionId || page.historyPath?.anchor.generation !== readPage.historyPath?.anchor.generation || page.historyPath?.anchor.leafEntryId !== readPage.historyPath?.anchor.leafEntryId)) throw new SessionTranscriptProjectionUnavailableError(params.readScope.sessionId);');
    return source;
  });
}

export function patchHistoryPathChat(source) {
  return sealedTransform(source, (source) => {
    source = replace(source, 'const result = readTranscriptDisplayDelta(params.scope, {', 'const result = readTranscriptDisplayDelta(params.scope, {\n\t\thistoryAnchor: params.historyAnchor,');
    source = replace(source, 'if (result.kind !== "page" || result.hasMore || containsTranscriptDiscontinuity(result)) return { kind: "reset" };', 'if (result.kind !== "page" || result.hasMore || containsTranscriptDiscontinuity(result) || result.historyPath?.relation === "reset" || result.historyPath?.relation === "off-path") return { kind: "reset", ...result.historyPath ? { historyPath: result.historyPath } : {} };');
    source = replace(source, '\t\tactiveLeafEntryId: result.activeLeafEntryId,\n\t\tdeltaCursor: result.cursor,', '\t\tactiveLeafEntryId: result.activeLeafEntryId,\n\t\thistoryPath: result.historyPath,\n\t\tdeltaCursor: result.cursor,');
    source = replace(source, 'effectiveMaxChars, offset, messageId } = params;', 'effectiveMaxChars, offset, messageId, historyAnchor } = params;');
    source = replace(source, 'incrementalTail = await readIncrementalChatHistoryTail({\n\t\t\t\tentry,', 'incrementalTail = await readIncrementalChatHistoryTail({\n\t\t\t\thistoryAnchor,\n\t\t\t\tentry,');
    source = replace(source, 'const incrementalTail = await readIncrementalChatHistoryTail({\n\t\tentry,', 'const incrementalTail = await readIncrementalChatHistoryTail({\n\t\thistoryAnchor,\n\t\tentry,');
    source = replace(source, '\t\t\t...isTailPage ? {\n\t\t\t\tactiveLeafEntryId:', '\t\t\t...isTailPage ? {\n\t\t\t\t...readPage.historyPath ? { historyPath: readPage.historyPath } : {},\n\t\t\t\tactiveLeafEntryId:');
    source = replace(source, '\treturn {\n\t\tactiveLeafEntryId,\n\t\t...readPage.transcriptSource', '\treturn {\n\t\tactiveLeafEntryId,\n\t\t...readPage.historyPath ? { historyPath: readPage.historyPath } : {},\n\t\t...readPage.transcriptSource');
    source = replace(source, 'maxChars, maxBytes, pendingBefore, inputRunIds } = params;', 'maxChars, maxBytes, pendingBefore, inputRunIds, historyAnchor } = params;');
    source = replace(source, '\t\t\tentry: historyEntry,\n\t\t\tprovider:', '\t\t\thistoryAnchor,\n\t\t\tentry: historyEntry,\n\t\t\tprovider:');
    source = replace(source, 'delta = readChatHistoryDelta({\n\t\t\t\tagentId:', 'delta = readChatHistoryDelta({\n\t\t\t\thistoryAnchor,\n\t\t\t\tagentId:');
    source = replace(source, '\t\t\tdeltaCursor: delta.deltaCursor,', '\t\t\tdeltaCursor: delta.deltaCursor,\n\t\t\thistoryPath: delta.historyPath,');
    source = replace(source, [
      '\t\t} : {},\n\t\t...historyPage.deltaCursor ? { deltaCursor: historyPage.deltaCursor } : {},',
      '\t\t} : {},\n\t\t...historyPage.historyPath ? { historyPath: historyPage.historyPath } : {},\n\t\t...historyPage.deltaCursor ? { deltaCursor: historyPage.deltaCursor } : {},',
    ], '\t\t} : {},\n\t\t...messageId === void 0 && (offset ?? 0) === 0 ? { historyPath: historyPage.historyPath ?? null } : {},\n\t\t...historyPage.deltaCursor ? { deltaCursor: historyPage.deltaCursor } : {},');
    return source;
  });
}

const historyAnchorSchema = 'Type.Optional(closedObject({sessionId:NonEmptyString,generation:Type.Union([NonEmptyString,Type.Null()]),leafEntryId:Type.Union([NonEmptyString,Type.Null()])}))';

export function patchHistoryPathSchema(source) {
  return sealedTransform(source, (source) => replace(source, [
    'const ChatHistoryParamsSchema = closedObject({\n\tsessionKey:',
    'const ChatHistoryParamsSchema = closedObject({\n\thistoryAnchor: Type.Optional(closedObject({sessionId:Type.String(),generation:Type.Union([Type.String(),Type.Null()]),leafEntryId:Type.Union([Type.String(),Type.Null()])})),\n\tsessionKey:',
  ], `const ChatHistoryParamsSchema = closedObject({\n\thistoryAnchor: ${historyAnchorSchema},\n\tsessionKey:`));
}

export function patchHistoryPathWorker(source) {
  return sealedTransform(source, (source) => {
    source = replace(source, 'function readTranscriptDisplayDelta(Ot,Zt={}){', `${pathProjection}function readTranscriptDisplayDelta(Ot,Zt={}){`);
    source = replace(source, 'let Dn=readTranscriptRawDelta(Ot,_n);if(Dn.kind!==`page`)return Dn;', 'let historyPath=readHistoryPath(Zt,_n.historyAnchor),Dn=readTranscriptRawDelta(Ot,_n);if(Dn.kind!==`page`)return{...Dn,historyPath};');
    source = replace(source, 'return{...Dn,activeLeafEntryId:Zt.state.leafEventId,events:pr}', 'return{...Dn,historyPath,activeLeafEntryId:Zt.state.leafEventId,events:pr}');
    source = replace(source, 'let _n=resolveVisibleHistoryProjection(Ot),Dn=readTranscriptProjectionGeneration(Ot),kn=Dn?createTranscriptRawDeltaCursor(', 'let _n=resolveVisibleHistoryProjection(Ot),historyPath=readHistoryPath(Ot,Zt.historyAnchor),Dn=historyPath.anchor.generation,kn=Dn?createTranscriptRawDeltaCursor(');
    source = replace(source, 'if(Pn===0||Fn===0)return{activeLeafEntryId:Ot.state.leafEventId,', 'if(Pn===0||Fn===0)return{historyPath,activeLeafEntryId:Ot.state.leafEventId,');
    source = replace(source, 'Jn=resolveRecentHistoryStart(Ot,Math.max(0,_n.total-Fn),_n.total,_n,Ln,Pn);return{activeLeafEntryId:', 'Jn=resolveRecentHistoryStart(Ot,Math.max(0,_n.total-Fn),_n.total,_n,Ln,Pn);return{historyPath,activeLeafEntryId:');
    source = replace(source, 'events:readVisibleHistoryRange(Ot,Ln,Pn,_n),', 'historyPath:readHistoryPath(Ot,Zt.historyAnchor),events:readVisibleHistoryRange(Ot,Ln,Pn,_n),');
    source = replace(source, 'Dn=Zt*20+20;return{maxMessages:Zt,', 'Dn=Zt*20+20;return{historyAnchor:Ot?.historyAnchor,maxMessages:Zt,');
    source = replace(source, '...Dn.deltaCursor?{deltaCursor:Dn.deltaCursor}:{},displaySource:Dn.displaySource,messages:projectSqliteHistoryEvents(Dn.events)', 'historyPath:Dn.historyPath,...Dn.deltaCursor?{deltaCursor:Dn.deltaCursor}:{},displaySource:Dn.displaySource,messages:projectSqliteHistoryEvents(Dn.events)');
    source = replace(source, '{activeLeafEntryId:Dn,deltaCursor:kn,displaySource:Pn,messages:Fn,transcriptEvents:Ln,totalMessages:Jn}=await readRecentSqliteMessageRecords', '{activeLeafEntryId:Dn,deltaCursor:kn,displaySource:Pn,historyPath,messages:Fn,transcriptEvents:Ln,totalMessages:Jn}=await readRecentSqliteMessageRecords');
    source = replace(source, 'return Jn===0&&Fn.length===0&&Zt.allowResetArchiveFallback===!0?await archivedTranscriptReader(_n).readRecentWithStats({...Zt,resetArchiveOnly:!0}):{...Dn===void 0?{}:{activeLeafEntryId:Dn}', 'if(Jn===0&&Fn.length===0&&Zt.allowResetArchiveFallback===!0){const archived=await archivedTranscriptReader(_n).readRecentWithStats({...Zt,resetArchiveOnly:!0});if(archived.transcriptSource!==void 0)return archived;}return{historyPath,...Dn===void 0?{}:{activeLeafEntryId:Dn}');
    source = replace(source, '...Dn.olderOffset===void 0?{}:{olderOffset:Dn.olderOffset},', 'historyPath:Dn.historyPath,...Dn.olderOffset===void 0?{}:{olderOffset:Dn.olderOffset},');
    source = replace(source, 'kn=Zt===0?await readRecentSessionMessagesWithStatsAsync(Ot.readScope,{maxMessages:Dn+1,', 'kn=Zt===0?await readRecentSessionMessagesWithStatsAsync(Ot.readScope,{historyAnchor:Ot.historyAnchor,maxMessages:Dn+1,');
    source = replace(source, 'if(pr.displaySource!==kn.displaySource)throw new SessionTranscriptProjectionUnavailableError(Ot.readScope.sessionId);', 'if(pr.displaySource!==kn.displaySource||Zt===0&&(pr.historyPath?.anchor.sessionId!==kn.historyPath?.anchor.sessionId||pr.historyPath?.anchor.generation!==kn.historyPath?.anchor.generation||pr.historyPath?.anchor.leafEntryId!==kn.historyPath?.anchor.leafEntryId))throw new SessionTranscriptProjectionUnavailableError(Ot.readScope.sessionId);');
    source = replace(source, '_n=readTranscriptDisplayDelta(Ot.scope,{cursor:Ot.cursor,', '_n=readTranscriptDisplayDelta(Ot.scope,{historyAnchor:Ot.historyAnchor,cursor:Ot.cursor,');
    source = replace(source, 'if(_n.kind!==`page`||_n.hasMore||containsTranscriptDiscontinuity(_n))return{kind:`reset`};', 'if(_n.kind!==`page`||_n.hasMore||containsTranscriptDiscontinuity(_n)||_n.historyPath?.relation===`reset`||_n.historyPath?.relation===`off-path`)return{kind:`reset`,..._n.historyPath?{historyPath:_n.historyPath}:{}};');
    source = replace(source, 'return{activeLeafEntryId:_n.activeLeafEntryId,deltaCursor:_n.cursor,kind:`delta`,', 'return{activeLeafEntryId:_n.activeLeafEntryId,historyPath:_n.historyPath,deltaCursor:_n.cursor,kind:`delta`,');
    source = replace(source, 'effectiveMaxChars:cr,offset:pr,messageId:xr}=Ot;', 'effectiveMaxChars:cr,offset:pr,messageId:xr,historyAnchor}=Ot;');
    source = replace(source, 'kn=await readIncrementalChatHistoryTail({entry:Zt,readScope:Mr,', 'kn=await readIncrementalChatHistoryTail({historyAnchor,entry:Zt,readScope:Mr,');
    source = replace(source, 'let Br=await readIncrementalChatHistoryTail({entry:Zt,readScope:Mr,', 'let Br=await readIncrementalChatHistoryTail({historyAnchor,entry:Zt,readScope:Mr,');
    source = replace(source, '...Pn?{activeLeafEntryId:resolveChatHistoryActiveLeafEntryId(Dn),', '...Pn?{...Dn.historyPath?{historyPath:Dn.historyPath}:{},activeLeafEntryId:resolveChatHistoryActiveLeafEntryId(Dn),');
    source = replace(source, 'return{activeLeafEntryId:mi,...Hr.transcriptSource===`active`', 'return{activeLeafEntryId:mi,...Hr.historyPath?{historyPath:Hr.historyPath}:{},...Hr.transcriptSource===`active`');
    source = replace(source, 'maxChars:xr,maxBytes:Mr,pendingBefore:Pr,inputRunIds:Br}=Ot;', 'maxChars:xr,maxBytes:Mr,pendingBefore:Pr,inputRunIds:Br,historyAnchor}=Ot;');
    source = replace(source, '()=>readChatHistoryPage({entry:sa,provider:ca.provider,', '()=>readChatHistoryPage({historyAnchor,entry:sa,provider:ca.provider,');
    source = replace(source, '_n=readChatHistoryDelta({agentId:Di,cursor:Jn,', '_n=readChatHistoryDelta({historyAnchor,agentId:Di,cursor:Jn,');
    source = replace(source, 'kind:`delta`,messages:_n.messages,deltaCursor:_n.deltaCursor,pendingInputs:fa,', 'kind:`delta`,messages:_n.messages,deltaCursor:_n.deltaCursor,historyPath:_n.historyPath,pendingInputs:fa,');
    source = replace(source, [
      'inputConsumptions:ma}:{},...ha.deltaCursor?{deltaCursor:ha.deltaCursor}:{},',
      'inputConsumptions:ma}:{},...ha.historyPath?{historyPath:ha.historyPath}:{},...ha.deltaCursor?{deltaCursor:ha.deltaCursor}:{},',
    ], 'inputConsumptions:ma}:{},...cr===void 0&&(Ln??0)===0?{historyPath:ha.historyPath??null}:{},...ha.deltaCursor?{deltaCursor:ha.deltaCursor}:{},');
    source = replace(source, [
      'ChatHistoryParamsSchema=closedObject$1({sessionKey:',
      'ChatHistoryParamsSchema=closedObject$1({historyAnchor:Optional$2(closedObject$1({sessionId:String$2(),generation:Union([String$2(),Null()]),leafEntryId:Union([String$2(),Null()])})),sessionKey:',
    ], 'ChatHistoryParamsSchema=closedObject$1({historyAnchor:Optional$2(closedObject$1({sessionId:NonEmptyString,generation:Union([NonEmptyString,Null()]),leafEntryId:Union([NonEmptyString,Null()])})),sessionKey:');
    return source;
  });
}

export function patchOpenClawHistoryPath(openclawDir) {
  const pkg = JSON.parse(read(path.join(openclawDir, 'package.json')));
  if (pkg.name !== 'openclaw' || pkg.version !== VERSION) throw new Error(`${PATCH}: requires openclaw@${VERSION}`);
  const dist = path.join(openclawDir, 'dist');
  const locate = (prefix, marker) => {
    const files = fs.readdirSync(dist).filter((name) => name.startsWith(prefix) && /\.(?:mjs|js)$/.test(name))
      .map((name) => path.join(dist, name)).filter((file) => read(file).includes(marker));
    if (files.length !== 1) throw new Error(`${PATCH}: expected one ${prefix} source, found ${files.length}`);
    return files[0];
  };
  const targets = [
    [locate('session-transcript-readers-', 'function readTranscriptDisplayDelta('), patchHistoryPathReaders],
    [locate('session-history-tail-', 'async function readIncrementalChatHistoryTail('), patchHistoryPathTail],
    [locate('chat-', 'async function handleChatHistoryRequest('), patchHistoryPathChat],
    [locate('sessions-', 'const ChatHistoryParamsSchema = closedObject({'), patchHistoryPathSchema],
    [path.join(dist, 'worker', 'worker.mjs'), patchHistoryPathWorker],
  ];
  const edits = targets.map(([file, transform]) => {
    const before = read(file);
    return { file, before, after: transform(before) };
  });
  const changed = edits.filter(({ before, after }) => before !== after);
  for (const { file, after } of changed) fs.writeFileSync(file, after);
  return { status: changed.length ? 'applied' : 'clean', detail: edits.map(({ file }) => path.relative(dist, file)).join(', ') };
}
