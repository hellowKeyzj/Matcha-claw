import { createHash } from 'node:crypto';

const PATCH = 'native-chat-stream-ownership';
const digest = (source) => createHash('sha256').update(source).digest('hex');

function replace(source, before, after) {
  if (source.split(after).length === 2) return source;
  if (source.includes(after) || source.split(before).length !== 2) {
    throw new Error(`${PATCH}: source anchor mismatch: ${before.slice(0, 100)}`);
  }
  return source.replace(before, () => after);
}

function transform(source, patch) {
  const seals = [];
  let body = source;
  for (;;) {
    const stamp = body.match(/^\/\/ (native-chat-commentary-replacement|native-history-path|native-chat-stream-ownership) sha256=([a-f0-9]{64})\n/);
    if (!stamp) break;
    body = body.slice(stamp[0].length);
    if (digest(body) !== stamp[2]) throw new Error(`${PATCH}: ${stamp[1]} source seal mismatch`);
    seals.push(stamp[1]);
  }
  body = patch(body);
  if (seals.length === 0) seals.push(PATCH);
  for (const seal of seals.reverse()) body = `// ${seal} sha256=${digest(body)}\n${body}`;
  return body;
}

const setStreamId = `function setAssistantStreamId(message, streamId) {
	if (message?.role !== "assistant" || !streamId) return;
	message.__openclaw = { ...message.__openclaw, streamId };
}
`;

// Session events are awaited by the native fragment producer. Subscription copies are not owners.
const sessionOwnership = `			const assistantEvent = (event.type === "message_start" || event.type === "message_update" || event.type === "message_end") && event.message.role === "assistant";
			if (event.type === "agent_start") this.assistantStreamId = void 0;
			if (assistantEvent && event.type === "message_start") this.assistantStreamId = randomUUID();
			const streamId = assistantEvent ? this.assistantStreamId : void 0;
			setAssistantStreamId(event.message, streamId);
`;
const restoreSessionOwnership = `
			setAssistantStreamId(event.message, streamId);
			if (streamId && event.type === "message_update" && event.assistantMessageEvent.partial) setAssistantStreamId(event.assistantMessageEvent.partial, streamId);
			if (assistantEvent && event.type === "message_end") this.assistantStreamId = void 0;`;

export function patchStreamOwnershipSession(source) {
  return transform(source, (source) => {
    source = replace(source, 'import { createHash, randomBytes } from "node:crypto";', 'import { createHash, randomBytes, randomUUID } from "node:crypto";');
    source = replace(source, 'function replaceAgentMessageInPlace(target, replacement) {', `${setStreamId}function replaceAgentMessageInPlace(target, replacement) {`);
    source = replace(source, '\t\tconst sourceSlots = event.type === "message_end" ? takeCodeModeResponseSource(event.message) : void 0;', `${sessionOwnership.replaceAll('\t\t\t', '\t\t')}\t\tconst sourceSlots = event.type === "message_end" ? takeCodeModeResponseSource(event.message) : void 0;`);
    source = replace(source, '\t\tconst messageChanged = await this.emitExtensionEvent(event);', `\t\tconst messageChanged = await this.emitExtensionEvent(event);${restoreSessionOwnership.replaceAll('\t\t\t', '\t\t')}`);
    return source;
  });
}

export function patchStreamOwnershipPersistence(source) {
  return transform(source, (source) => {
    source = replace(source, 'function installSessionToolResultGuard(sessionManager, opts) {', `${setStreamId}function installSessionToolResultGuard(sessionManager, opts) {`);
    source = replace(source, '\t\tconst callerInvalidatesCache = callerOptions?.invalidateSerializedPrefixCache === true;', '\t\tconst streamId = message.role === "assistant" ? message.__openclaw?.streamId : void 0;\n\t\tconst callerInvalidatesCache = callerOptions?.invalidateSerializedPrefixCache === true;');
    source = replace(source, '\t\tconst { anchor, appended, entryId: result, message: persistedMessage, messageSeq, sessionTarget } = appendMessageAndCacheTranscriptSeq(finalMessage,', '\t\tsetAssistantStreamId(finalMessage, streamId);\n\t\tconst { anchor, appended, entryId: result, message: persistedMessage, messageSeq, sessionTarget } = appendMessageAndCacheTranscriptSeq(finalMessage,');
    return source;
  });
}

const taggedThinking = `function extractAssistantTaggedThinking(message, finalMessage = false) {
	const text = extractTextFromChatContent(message.content, { joinWith: "\\n", normalizeText: (text) => text }) ?? "";
	return finalMessage ? extractThinkingFromTaggedText(text) : extractThinkingFromTaggedStream(text, createThinkingTagStreamState(), "");
}
`;

export function patchStreamOwnershipProducer(source) {
  return transform(source, (source) => {
    source = replace(source, 'function handleMessageStart(ctx, evt) {', `${taggedThinking}function handleMessageStart(ctx, evt) {`);
    source = replace(source, 'extractAssistantThinking(assistantMessage) || extractThinkingFromTaggedText(getRawText())', 'extractAssistantThinking(assistantMessage) || extractAssistantTaggedThinking(assistantMessage, true)');
    source = replace(source, 'ctx.emitReasoningStream(rawThinking);', 'ctx.emitReasoningStream(rawThinking, void 0, assistantMessage.__openclaw?.streamId);');
    source = replace(source, 'ctx.emitReasoningStream(nativeThinking ?? (extractAssistantThinking(msg) || thinkingContent || thinkingDelta), nativeThinking ? thinkingContent || thinkingDelta : void 0);', 'ctx.emitReasoningStream(nativeThinking ?? (extractAssistantThinking(msg) || thinkingContent || thinkingDelta), nativeThinking ? thinkingContent || thinkingDelta : void 0, msg.__openclaw?.streamId);');
    source = replace(source, 'ctx.emitReasoningStream(extractThinkingFromTaggedStream(ctx.state.deltaBuffer, ctx.state.thinkingTagStream, chunk));', 'ctx.emitReasoningStream(extractAssistantThinking(msg) || extractAssistantTaggedThinking(msg), void 0, msg.__openclaw?.streamId);');
    source = replace(source, '\tlet reasoningRaw;', '\tlet reasoningRaw;\n\tlet reasoningStreamId;');
    source = replace(source, '\tconst emitReasoningStream = (input, fallback) => {\n\t\tif (params.silentExpected) return;', `\tconst emitReasoningStream = (input, fallback, streamId) => {
		if (params.silentExpected) return;
		if (reasoningStreamId !== streamId) {
			reasoningStreamId = streamId;
			state.lastStreamedReasoning = void 0;
			reasoningProjection = createTextProjection([trimTextFilter("both")]);
			reasoningRaw = void 0;
		}`);
    source = replace(source, '\t\t\tstream: "thinking",\n\t\t\tdata: {\n\t\t\t\ttext: trimmed,\n\t\t\t\tdelta\n', '\t\t\tstream: "thinking",\n\t\t\tdata: {\n\t\t\t\ttext: trimmed,\n\t\t\t\tdelta,\n\t\t\t\t...streamId ? { streamId } : {},\n\t\t\t\t...!trimmed.startsWith(prior) ? { isReasoningSnapshot: true } : {}\n');
    source = replace(source, '\tconst resetAssistantMessageState = (nextAssistantTextBaseline) => {', '\tconst resetAssistantMessageState = (nextAssistantTextBaseline, preserveReasoning = false) => {');
    source = replace(source, '\t\tstate.lastStreamedReasoning = void 0;\n\t\treasoningProjection = createTextProjection([trimTextFilter("both")]);\n\t\treasoningRaw = void 0;', '\t\tif (!preserveReasoning) {\n\t\t\tstate.lastStreamedReasoning = void 0;\n\t\t\treasoningProjection = createTextProjection([trimTextFilter("both")]);\n\t\t\treasoningRaw = void 0;\n\t\t}');
    source = replace(source, '\t\t\tctx.resetAssistantMessageState(ctx.state.assistantTexts.length);\n\t\t\temitAssistantMessageStart(ctx);', '\t\t\tctx.resetAssistantMessageState(ctx.state.assistantTexts.length, true);\n\t\t\temitAssistantMessageStart(ctx);');
    return source;
  });
}

export function patchStreamOwnershipGateway(source) {
  return transform(source, (source) => {
    source = replace(source, '\t\t\t\tpayload.data.itemId,\n\t\t\t\tsessionKey,', '\t\t\t\tpayload.data.itemId,\n\t\t\t\tpayload.data.streamId,\n\t\t\t\tsessionKey,');
    source = replace(source, 'previous.payload.data.itemId === payload.data.itemId && previous.sessionKey', 'previous.payload.data.itemId === payload.data.itemId && previous.payload.data.streamId === payload.data.streamId && previous.sessionKey');
    source = replace(source, 'evt.data.replace !== true && (evt.stream === "item"', 'evt.data.replace !== true && evt.data.isReasoningSnapshot !== true && (evt.stream === "item"');
    return source;
  });
}

const workerThinking = `	let thinkingStreamId;
	const emitThinkingSnapshot = (message) => {
		const streamId = message.__openclaw?.streamId;
		if (thinkingStreamId !== streamId) {
			thinkingStreamId = streamId;
			streamedThinking = "";
		}
		const text = readAssistantThinking(message);
		if (text === streamedThinking) return;
		const isReasoningSnapshot = !text.startsWith(streamedThinking);
		const delta = isReasoningSnapshot ? text : text.slice(streamedThinking.length);
		streamedThinking = text;
		enqueueLive({
			kind: "thinking",
			payload: { text, delta, ...streamId ? { streamId } : {}, ...isReasoningSnapshot ? { isReasoningSnapshot: true } : {} }
		});
	};
`;

export function patchStreamOwnershipEmbedded(source) {
  return transform(source, (source) => {
    source = replace(source, '\t\tkind: "thinking",\n\t\tpayload: {\n\t\t\ttext: truncateLiveText(event.payload.text),', '\t\tkind: "thinking",\n\t\tpayload: {\n\t\t\t...event.payload,\n\t\t\ttext: truncateLiveText(event.payload.text),');
    source = replace(source, '\tlet streamedThinking = "";\n\tconst emitAssistantSnapshot', `\tlet streamedThinking = "";\n${workerThinking}\tconst emitAssistantSnapshot`);
    source = replace(source, `			else if (event.assistantMessageEvent.type === "thinking_delta") {
				streamedThinking = readAssistantThinking(event.message);
				enqueueLive({
					kind: "thinking",
					payload: {
						text: streamedThinking,
						delta: event.assistantMessageEvent.delta
					}
				});
			}`, '\t\t\telse if (event.assistantMessageEvent.type === "thinking_delta") emitThinkingSnapshot(event.message);');
    source = replace(source, `			const finalThinking = readAssistantThinking(event.message);
			if (finalThinking !== streamedThinking) enqueueLive({
				kind: "thinking",
				payload: {
					text: finalThinking,
					delta: finalThinking
				}
			});`, '\t\t\temitThinkingSnapshot(event.message);');
    return source;
  });
}

export function patchStreamOwnershipTranscript(source) {
  return transform(source, (source) => {
    source = replace(source, 'function toWorkerAssistantMessage(message) {', 'function toWorkerAssistantMessage(message, purpose) {');
    source = replace(source, '\t\t...message.responseId ? { responseId: message.responseId } : {},', '\t\t...message.responseId ? { responseId: message.responseId } : {},\n\t\t...purpose === "transcript" && message.__openclaw?.streamId ? { __openclaw: { streamId: message.__openclaw.streamId } } : {},');
    source = replace(source, 'message: toWorkerAssistantMessage(message),', 'message: toWorkerAssistantMessage(message, purpose),');
    return source;
  });
}

export function patchStreamOwnershipCommit(source) {
  return transform(source, (source) => replace(source,
    '\t\t...message.responseId ? { responseId: message.responseId } : {},',
    '\t\t...message.responseId ? { responseId: message.responseId } : {},\n\t\t...message.__openclaw?.streamId ? { __openclaw: { streamId: message.__openclaw.streamId } } : {},'));
}

export function patchStreamOwnershipWorkerSchema(source) {
  return transform(source, (source) => {
    source = replace(source, '\tresponseId: Type.Optional(WorkerIdentifierSchema),', '\tresponseId: Type.Optional(WorkerIdentifierSchema),\n\t__openclaw: Type.Optional(closedObject({ streamId: WorkerIdentifierSchema })),');
    source = replace(source, 'const WorkerLiveThinkingPayloadSchema = workerLiveObject({\n\ttext: LiveTextSchema,\n\tdelta: LiveTextSchema\n});', 'const WorkerLiveThinkingPayloadSchema = workerLiveObject({\n\ttext: LiveTextSchema,\n\tdelta: LiveTextSchema,\n\tstreamId: Type.Optional(WorkerIdentifierSchema),\n\tisReasoningSnapshot: Type.Optional(Type.Literal(true))\n});');
    return source;
  });
}

export function patchStreamOwnershipWorker(source) {
  return transform(source, (source) => {
    source = replace(source, 'function replaceAgentMessageInPlace(Ot,Zt){', `${setStreamId}function replaceAgentMessageInPlace(Ot,Zt){`);
    source = replace(source, 'async handleAgentEventUnlocked(Ot){', `async handleAgentEventUnlocked(Ot){
${sessionOwnership.replaceAll('event.', 'Ot.')}`);
    source = replace(source, '_n=await this.emitExtensionEvent(Ot),Dn=Ot.type===`message_end`&&Ot.message.role===`user`;', `_n=await this.emitExtensionEvent(Ot),Dn=Ot.type===\`message_end\`&&Ot.message.role===\`user\`;${restoreSessionOwnership.replaceAll('event.', 'Ot.')}`);
    source = replace(source, 'guardedAppend=(_n,Dn,Fn)=>{let Ln=', 'guardedAppend=(_n,Dn,Fn)=>{const streamId=_n.role==="assistant"?_n.__openclaw?.streamId:void 0;let Ln=');
    source = replace(source, 'let{anchor:ea,appended:ta,entryId:na,message:ra,messageSeq:ia,sessionTarget:aa}=appendMessageAndCacheTranscriptSeq(Di,', 'setAssistantStreamId(Di,streamId);let{anchor:ea,appended:ta,entryId:na,message:ra,messageSeq:ia,sessionTarget:aa}=appendMessageAndCacheTranscriptSeq(Di,');
    source = replace(source, 'function handleMessageStart(Ot,Zt){', `${taggedThinking}function handleMessageStart(Ot,Zt){`);
    source = replace(source, 'extractAssistantThinking(Dn)||extractThinkingFromTaggedText(getRawText())', 'extractAssistantThinking(Dn)||extractAssistantTaggedThinking(Dn,!0)');
    source = replace(source, 'Ot.emitReasoningStream(Pr)', 'Ot.emitReasoningStream(Pr,void 0,Dn.__openclaw?.streamId)');
    source = replace(source, 'Ot.emitReasoningStream(Ln??(extractAssistantThinking(_n)||Dn||Zt),Ln?Dn||Zt:void 0)', 'Ot.emitReasoningStream(Ln??(extractAssistantThinking(_n)||Dn||Zt),Ln?Dn||Zt:void 0,_n.__openclaw?.streamId)');
    source = replace(source, 'Ot.emitReasoningStream(extractThinkingFromTaggedStream(Ot.state.deltaBuffer,Ot.state.thinkingTagStream,oa))', 'Ot.emitReasoningStream(extractAssistantThinking(_n)||extractAssistantTaggedThinking(_n),void 0,_n.__openclaw?.streamId)');
    source = replace(source, 'Pr=createTextProjection([trimTextFilter(`both`)]),Br,stripBlockTags=', 'Pr=createTextProjection([trimTextFilter(`both`)]),Br,reasoningStreamId,stripBlockTags=');
    source = replace(source, 'emitReasoningStream:(Dn,kn)=>{if(Ot.silentExpected)return;', 'emitReasoningStream:(Dn,kn,streamId)=>{if(Ot.silentExpected)return;if(reasoningStreamId!==streamId){reasoningStreamId=streamId;Zt.lastStreamedReasoning=void 0;Pr=createTextProjection([trimTextFilter(`both`)]);Br=void 0;}');
    source = replace(source, 'stream:`thinking`,data:{text:pr,delta:Mr}', 'stream:`thinking`,data:{text:pr,delta:Mr,...streamId?{streamId}:{},...!pr.startsWith(xr)?{isReasoningSnapshot:!0}:{}}');
    source = replace(source, 'resetAssistantMessageState:Ot=>{Pn(),', 'resetAssistantMessageState:(Ot,preserveReasoning=!1)=>{Pn(),');
    source = replace(source, 'Zt.lastStreamedReasoning=void 0,Pr=createTextProjection([trimTextFilter(`both`)]),Br=void 0,', 'preserveReasoning||(Zt.lastStreamedReasoning=void 0,Pr=createTextProjection([trimTextFilter(`both`)]),Br=void 0),');
    source = replace(source, 'Ot.flushBlockReplyBuffer({assistantMessageIndex:Ot.state.assistantMessageIndex}),Ot.resetAssistantMessageState(Ot.state.assistantTexts.length),emitAssistantMessageStart(Ot)', 'Ot.flushBlockReplyBuffer({assistantMessageIndex:Ot.state.assistantMessageIndex}),Ot.resetAssistantMessageState(Ot.state.assistantTexts.length,!0),emitAssistantMessageStart(Ot)');
    source = replace(source, 'function toWorkerAssistantMessage(Ot){', 'function toWorkerAssistantMessage(Ot,purpose){');
    source = replace(source, '...Ot.responseId?{responseId:Ot.responseId}:{},...Ot.diagnostics?', '...Ot.responseId?{responseId:Ot.responseId}:{},...purpose==="transcript"&&Ot.__openclaw?.streamId?{__openclaw:{streamId:Ot.__openclaw.streamId}}:{},...Ot.diagnostics?');
    source = replace(source, 'message:toWorkerAssistantMessage(Ot),providerReplay:', 'message:toWorkerAssistantMessage(Ot,Zt),providerReplay:');
    source = replace(source, '...Ot.responseId?{responseId:Ot.responseId}:{},...Ot.providerReplay?{providerReplay:structuredClone(Ot.providerReplay)}:{},', '...Ot.responseId?{responseId:Ot.responseId}:{},...Ot.__openclaw?.streamId?{__openclaw:{streamId:Ot.__openclaw.streamId}}:{},...Ot.providerReplay?{providerReplay:structuredClone(Ot.providerReplay)}:{},');
    source = replace(source, 'responseId:Optional$2(WorkerIdentifierSchema),providerReplay:Optional$2(WorkerProviderReplayStateSchema),diagnostics:', 'responseId:Optional$2(WorkerIdentifierSchema),__openclaw:Optional$2(closedObject$1({streamId:WorkerIdentifierSchema})),providerReplay:Optional$2(WorkerProviderReplayStateSchema),diagnostics:');
    source = replace(source, 'WorkerLiveThinkingPayloadSchema=workerLiveObject({text:LiveTextSchema,delta:LiveTextSchema})', 'WorkerLiveThinkingPayloadSchema=workerLiveObject({text:LiveTextSchema,delta:LiveTextSchema,streamId:Optional$2(WorkerIdentifierSchema),isReasoningSnapshot:Optional$2(Literal(!0))})');
    source = replace(source, 'kind:`thinking`,payload:{text:truncateLiveText(Ot.payload.text),delta:', 'kind:`thinking`,payload:{...Ot.payload,text:truncateLiveText(Ot.payload.text),delta:');
    source = replace(source, 'Jn=``,emitAssistantSnapshot=Ot=>{', `Jn=\`\`;${workerThinking.replaceAll('streamedThinking', 'Jn')}const emitAssistantSnapshot=Ot=>{`);
    source = replace(source, 'Ot.assistantMessageEvent.type===`thinking_delta`&&(Jn=readAssistantThinking(Ot.message),enqueueLive({kind:`thinking`,payload:{text:Jn,delta:Ot.assistantMessageEvent.delta}}))', 'Ot.assistantMessageEvent.type===`thinking_delta`&&emitThinkingSnapshot(Ot.message)');
    source = replace(source, 'let Zt=readAssistantThinking(Ot.message);Zt!==Jn&&enqueueLive({kind:`thinking`,payload:{text:Zt,delta:Zt}});', 'emitThinkingSnapshot(Ot.message);');
    return source;
  });
}
