import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import {
  patchStreamOwnershipSession,
  patchStreamOwnershipPersistence,
  patchStreamOwnershipProducer,
  patchStreamOwnershipGateway,
  patchStreamOwnershipEmbedded,
  patchStreamOwnershipTranscript,
  patchStreamOwnershipCommit,
  patchStreamOwnershipWorkerSchema,
  patchStreamOwnershipWorker,
} from './openclaw-stream-ownership-patches.mjs';

const VERSION = '2026.9.3';
const PATCH = 'native-chat-commentary-replacement';
const read = (file) => fs.readFileSync(file, 'utf8');
const digest = (source) => createHash('sha256').update(source).digest('hex');

function sealedTransform(source, transform) {
  const stamp = source.match(/^\/\/ native-chat-commentary-replacement sha256=([a-f0-9]{64})\n/);
  if (stamp) {
    if (digest(source.slice(stamp[0].length)) !== stamp[1]) throw new Error(`${PATCH}: source seal mismatch`);
    return source;
  }
  const body = transform(source);
  return `// ${PATCH} sha256=${digest(body)}\n${body}`;
}

function replace(source, before, after) {
  if (source.split(after).length === 2) return source;
  if (source.includes(after) || source.split(before).length !== 2) {
    throw new Error(`${PATCH}: source anchor mismatch: ${before.slice(0, 100)}`);
  }
  return source.replace(before, after);
}

// Re-project the producer's complete message, not a substring of the emitted X.
// Native phase/signature selection retains unrelated blocks and equal-text occurrences.
const sourceProjection = `function projectAssistantSourceText(ctx, message, finalMessage) {
	const text = extractAssistantStreamSnapshot(ctx, message).text;
	return parseReplyDirectives(finalMessage ? text.trim() : splitTrailingDirective(text).text).text;
}
`;

export function patchChatStreamProducer(source) {
  return sealedTransform(source, patchProducer);
}

function patchProducer(source) {
  source = replace(source, 'function emitAssistantCommentaryStreamData(ctx, message, finalMessage = false) {', `${sourceProjection}function emitAssistantCommentaryStreamData(ctx, message, finalMessage = false) {`);
  source = replace(source, '\t\t}, { finalMessage });\n\t}\n}\nfunction emitReasoningEnd(ctx)', '\t\t}, { finalMessage, sourceText: () => projectAssistantSourceText(ctx, message, finalMessage) });\n\t}\n}\nfunction emitReasoningEnd(ctx)');
  source = replace(source, '\t\t}, { finalMessage: evtType === "text_end" });', '\t\t}, { finalMessage: evtType === "text_end", sourceText: () => projectAssistantSourceText(ctx, partialAssistant, evtType === "text_end") });');
  source = replace(source, '\t\t\t}, { emitPartialReply: !currentSourcePartial.hold });', '\t\t\t}, { emitPartialReply: !currentSourcePartial.hold, sourceText: () => projectAssistantSourceText(ctx, partialAssistant, evtType === "text_end") });');
  source = replace(source, '\tlet finalized = false;\n\tconst emitAssistantStreamDataSafely', '\tlet finalized = false;\n\tlet streamMessage;\n\tconst emitAssistantStreamDataSafely');
  source = replace(source, '\t\tconst { eventData } = delivery;', '\t\tconst eventData = delivery.message && delivery.revision !== delivery.message.revision ? void 0 : delivery.eventData;');
  source = replace(source, '\tconst emitAssistantStreamData = (data, options) => {\n\t\tif (state.unsubscribed) return;\n\t\tlet eventData;', `\tconst emitAssistantStreamData = (data, options) => {
		if (state.unsubscribed) return;
		if (data.phase === "commentary" && streamMessage?.index === state.assistantMessageStartIndex && options?.sourceText) {
			streamMessage.reconciled = true;
			const text = options.sourceText();
			if (text !== streamedText) emitAssistantStreamData({ text, delta: "", replace: true }, { reconcile: true, finalMessage: finalized });
		}
		let eventData;`);
  source = replace(source, '\t\t\t\tmessageIndex = state.assistantMessageStartIndex;\n\t\t\t\tblockIndex', '\t\t\t\tmessageIndex = state.assistantMessageStartIndex;\n\t\t\t\tstreamMessage = { index: messageIndex, revision: 0, reconciled: false };\n\t\t\t\tblockIndex');
  source = replace(source, '\t\t\tif (!finalized || options?.finalMessage) {', '\t\t\tif (!finalized || options?.finalMessage || options?.reconcile) {\n\t\t\t\tif (options?.reconcile) streamMessage.revision += 1;');
  source = replace(source, `\t\t\t\tconst text = options?.finalMessage ? data.text : prefix && data.text ? \`\${prefix}\\n\${data.text}\` : prefix || data.text;
				const replace = options?.finalMessage ? !text.startsWith(streamedText) : data.replace === true;
				const delta = options?.finalMessage ? replace ? "" : text.slice(streamedText.length) : prefix && streamedText.length === prefix.length && data.delta ? \`\\n\${data.delta}\` : data.delta;`, `\t\t\t\tconst wholeMessage = options?.finalMessage || options?.reconcile || streamMessage.reconciled && options?.sourceText;
				const text = options?.finalMessage || options?.reconcile ? data.text : wholeMessage ? options.sourceText() : prefix && data.text ? \`\${prefix}\\n\${data.text}\` : prefix || data.text;
				const replace = options?.reconcile || (wholeMessage ? !text.startsWith(streamedText) : data.replace === true);
				const delta = wholeMessage ? replace ? "" : text.slice(streamedText.length) : prefix && streamedText.length === prefix.length && data.delta ? \`\\n\${data.delta}\` : data.delta;`);
  source = replace(source, '\t\t\tblockIndex: state.assistantMessageIndex\n\t\t};', '\t\t\tblockIndex: state.assistantMessageIndex,\n\t\t\tmessage: streamMessage,\n\t\t\trevision: streamMessage?.revision\n\t\t};');
  source = replace(source, '\t\t\tif (event.stream === "item") lastEmittedCommentaryByItem.set(itemId, commentarySignature);', '\t\t\tif (event.stream === "assistant" && delivery.message) delivery.message.emitted = true;\n\t\t\tif (event.stream === "item") lastEmittedCommentaryByItem.set(itemId, commentarySignature);');
  source = replace(source, '\t\t\trevision: streamMessage?.revision\n', '\t\t\trevision: streamMessage?.revision,\n\t\t\timmediate: options?.reconcile && streamMessage?.emitted\n');
  source = replace(source, 'const deferred = state.deferBlockReplyDelivery && data.phase !== "commentary";', 'const deferred = state.deferBlockReplyDelivery && data.phase !== "commentary" && !delivery.immediate;');
  source = replace(source, 'if (delivery && state.deferBlockReplyDelivery && delivery.data.phase !== "commentary")', 'if (delivery && state.deferBlockReplyDelivery && delivery.data.phase !== "commentary" && !delivery.immediate)');
  source = replace(source, 'if (!state.deferBlockReplyDelivery || previous.delivery?.data.phase === "commentary")', 'if (!state.deferBlockReplyDelivery || previous.delivery?.immediate || previous.delivery?.data.phase === "commentary")');
  source = replace(source, '\tconst clearAssistantStream = () => {\n\t\tstreamScope.delivery', '\tconst clearAssistantStream = () => {\n\t\tif (streamMessage) streamMessage.revision += 1;\n\t\tstreamMessage = void 0;\n\t\tstreamScope.delivery');
  // A synchronous callback may publish another provider event. Finish the current
  // source conversion (replacement, then preamble) before that event advances state.
  source = replace(source, 'function createEmbeddedAgentSessionEventHandler(ctx) {\n\tconst scheduleEvent = (evt, handler) => {', `function createEmbeddedAgentSessionEventHandler(ctx) {
	let scheduling = false;
	const reentrantEvents = [];
	const scheduleEvent = (evt, handler) => {
		if (scheduling) {
			reentrantEvents.push([evt, handler]);
			return;
		}
		scheduling = true;
		try {`);
  source = replace(source, '\t\tctx.state.pendingEventChain = task;\n\t\treturn task;\n\t};\n\treturn (evt) => {', `\t\tctx.state.pendingEventChain = task;
		return task;
		} finally {
			scheduling = false;
			if (reentrantEvents.length) scheduleEvent(...reentrantEvents.shift());
		}
	};
	return (evt) => {`);
  return source;
}

export function patchChatStreamWorker(source) {
  return sealedTransform(source, patchWorker);
}

function patchWorker(source) {
  source = replace(source, 'function emitAssistantCommentaryStreamData(Ot,Zt,_n=!1){', `${sourceProjection}function emitAssistantCommentaryStreamData(Ot,Zt,_n=!1){`);
  source = replace(source, 'phase:`commentary`,itemId:kn},{finalMessage:_n})}}', 'phase:`commentary`,itemId:kn},{finalMessage:_n,sourceText:()=>projectAssistantSourceText(Ot,Zt,_n)})}}');
  source = replace(source, 'phase:`commentary`,itemId:aa},{finalMessage:Pn===`text_end`});', 'phase:`commentary`,itemId:aa},{finalMessage:Pn===`text_end`,sourceText:()=>projectAssistantSourceText(Ot,Br,Pn===`text_end`)});');
  source = replace(source, 'let Br=Ln,Hr=resolveAssistantStreamContentIndex', 'let sourceAssistant=Ln,Br=Ln,Hr=resolveAssistantStreamContentIndex');
  source = replace(source, 'phase:wi??cr},{emitPartialReply:!Zt.hold})', 'phase:wi??cr},{emitPartialReply:!Zt.hold,sourceText:()=>projectAssistantSourceText(Ot,sourceAssistant,Pn===`text_end`)})');
  source = replace(source, 'Br=``,Hr=``,mi=!1,emitAssistantStreamDataSafely=', 'Br=``,Hr=``,mi=!1,streamMessage,emitAssistantStreamDataSafely=');
  source = replace(source, 'let kn=Dn.delivery,{eventData:Pn}=kn;', 'let kn=Dn.delivery,Pn=kn.message&&kn.revision!==kn.message.revision?void 0:kn.eventData;');
  source = replace(source, 'emitAssistantStreamData=(Ot,_n)=>{if(Zt.unsubscribed)return;let Dn;', `emitAssistantStreamData=(Ot,_n)=>{if(Zt.unsubscribed)return;
if(Ot.phase==="commentary"&&streamMessage?.index===Zt.assistantMessageStartIndex&&_n?.sourceText){
streamMessage.reconciled=true;
const text=_n.sourceText();
if(text!==Hr)emitAssistantStreamData({text,delta:"",replace:true},{reconcile:true,finalMessage:mi});
}
let Dn;`);
  source = replace(source, 'xr=Zt.assistantMessageStartIndex,Mr=Zt.assistantMessageIndex,Pr=', 'xr=Zt.assistantMessageStartIndex,streamMessage={index:xr,revision:0,reconciled:false},Mr=Zt.assistantMessageIndex,Pr=');
  source = replace(source, '!mi||_n?.finalMessage){Mr!==Zt.assistantMessageIndex', '!mi||_n?.finalMessage||_n?.reconcile){if(_n?.reconcile)streamMessage.revision+=1;Mr!==Zt.assistantMessageIndex');
  source = replace(source, 'let kn=_n?.finalMessage?Ot.text:Br&&Ot.text?`${Br}\\n${Ot.text}`:Br||Ot.text,Pn=_n?.finalMessage?!kn.startsWith(Hr):Ot.replace===!0,Fn=_n?.finalMessage?Pn?``:kn.slice(Hr.length):Br&&Hr.length===Br.length&&Ot.delta?`\\n${Ot.delta}`:Ot.delta;', 'let wholeMessage=_n?.finalMessage||_n?.reconcile||streamMessage.reconciled&&_n?.sourceText,kn=_n?.finalMessage||_n?.reconcile?Ot.text:wholeMessage?_n.sourceText():Br&&Ot.text?`${Br}\\n${Ot.text}`:Br||Ot.text,Pn=_n?.reconcile||(wholeMessage?!kn.startsWith(Hr):Ot.replace===!0),Fn=wholeMessage?Pn?``:kn.slice(Hr.length):Br&&Hr.length===Br.length&&Ot.delta?`\\n${Ot.delta}`:Ot.delta;');
  source = replace(source, 'blockIndex:Zt.assistantMessageIndex};if(!Dn&&!kn.emitPartialReply)', 'blockIndex:Zt.assistantMessageIndex,message:streamMessage,revision:streamMessage?.revision};if(!Dn&&!kn.emitPartialReply)');
  source = replace(source, 'xr.stream===`item`&&Fn.set(Ln,pr),emitAgentEvent', 'xr.stream===`assistant`&&kn.message&&(kn.message.emitted=true),xr.stream===`item`&&Fn.set(Ln,pr),emitAgentEvent');
  source = replace(source, 'message:streamMessage,revision:streamMessage?.revision};', 'message:streamMessage,revision:streamMessage?.revision,immediate:_n?.reconcile&&streamMessage?.emitted};');
  source = replace(source, 'Fn=Zt.deferBlockReplyDelivery&&Ot.phase!==`commentary`,Ln=', 'Fn=Zt.deferBlockReplyDelivery&&Ot.phase!==`commentary`&&!kn.immediate,Ln=');
  source = replace(source, 'Ot&&Zt.deferBlockReplyDelivery&&Ot.data.phase!==`commentary`&&kn.push(Dn)', 'Ot&&Zt.deferBlockReplyDelivery&&Ot.data.phase!==`commentary`&&!Ot.immediate&&kn.push(Dn)');
  source = replace(source, '(!Zt.deferBlockReplyDelivery||_n.delivery?.data.phase===`commentary`)', '(!Zt.deferBlockReplyDelivery||_n.delivery?.immediate||_n.delivery?.data.phase===`commentary`)');
  source = replace(source, 'clearAssistantStream=()=>{cr.delivery=void 0,cr={},kn.length=0,Pn.clear()}', 'clearAssistantStream=()=>{if(streamMessage)streamMessage.revision+=1;streamMessage=void 0;cr.delivery=void 0,cr={},kn.length=0,Pn.clear()}');
  source = replace(source, 'function createEmbeddedAgentSessionEventHandler(Ot){let scheduleEvent=(Zt,_n)=>{', `function createEmbeddedAgentSessionEventHandler(Ot){let scheduling=false,reentrantEvents=[];let scheduleEvent=(Zt,_n)=>{
if(scheduling){reentrantEvents.push([Zt,_n]);return;}scheduling=true;try{`);
  source = replace(source, 'Ot.state.pendingEventChain=kn,kn};return Zt=>{switch(Ot.captureModelEvent(Zt),Zt.type){', 'Ot.state.pendingEventChain=kn,kn}finally{scheduling=false;if(reentrantEvents.length)scheduleEvent(...reentrantEvents.shift());}};return Zt=>{switch(Ot.captureModelEvent(Zt),Zt.type){');
  return source;
}

export function patchChatReplacementPacing(source) {
  return replace(source,
    '\t\tif (run.deltaSentAt !== void 0) {\n\t\t\tscheduleChatDeltaFlush',
    '\t\tif (run.deltaSentAt !== void 0 && !input.replace) {\n\t\t\tscheduleChatDeltaFlush');
}

export function patchOpenClawChatStream(openclawDir) {
  const pkg = JSON.parse(read(path.join(openclawDir, 'package.json')));
  if (pkg.name !== 'openclaw' || pkg.version !== VERSION) throw new Error(`${PATCH}: requires openclaw@${VERSION}`);
  const dist = path.join(openclawDir, 'dist');
  const locate = (prefix, marker) => {
    const files = fs.readdirSync(dist).filter((name) => name.startsWith(prefix) && /\.(?:mjs|js)$/.test(name))
      .map((name) => path.join(dist, name)).filter((file) => read(file).includes(marker));
    if (files.length !== 1) throw new Error(`${PATCH}: expected one ${prefix} source, found ${files.length}`);
    return files[0];
  };
  const producer = locate('builtin-openclaw-', 'function createReplyDelivery(');
  const worker = path.join(dist, 'worker', 'worker.mjs');
  const gateway = locate('server-chat-', 'const previousRawText = run.rawBuffer ?? "";');
  const edits = [
    [producer, (source) => patchStreamOwnershipProducer(patchChatStreamProducer(source))],
    [worker, (source) => patchStreamOwnershipWorker(patchChatStreamWorker(source))],
    [gateway, (source) => patchStreamOwnershipGateway(patchChatReplacementPacing(source))],
    [locate('resource-loader-', 'async handleAgentEventUnlocked(event) {'), patchStreamOwnershipSession],
    [locate('resource-loader-', 'function installSessionToolResultGuard('), patchStreamOwnershipPersistence],
    [locate('embedded-agent.runtime-', 'function createWorkerLiveRuntime('), patchStreamOwnershipEmbedded],
    [locate('transcript-message-', 'function toWorkerAssistantMessage('), patchStreamOwnershipTranscript],
    [locate('transcript-commit-', 'function buildCommittedMessage('), patchStreamOwnershipCommit],
    [locate('worker-admission-', 'const WorkerLiveThinkingPayloadSchema = workerLiveObject({'), patchStreamOwnershipWorkerSchema],
  ].map(([file, transform]) => {
    const before = read(file);
    return { file, before, after: transform(before) };
  });
  const changed = edits.filter(({ before, after }) => before !== after);
  for (const { file, after } of changed) fs.writeFileSync(file, after);
  return { status: changed.length ? 'applied' : 'clean', detail: edits.map(({ file }) => path.relative(dist, file)).join(', ') };
}
