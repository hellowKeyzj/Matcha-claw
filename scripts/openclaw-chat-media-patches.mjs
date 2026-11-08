import fs from 'node:fs';
import path from 'node:path';

const VERSION = '2026.9.3';
const PATCH = 'native-chat-media-supplement';

const BEFORE = `		if (assistantMessageIndex === void 0 && mediaNormalizationFailed && hasOnlyFailureDisplay && runtimeOwnedText) return;
		const appended = await appendAssistantTranscriptMessage({
			sessionKey,
			message: transcriptReply,
			content: persistedContentForAppend,
			sessionId,`;

const AFTER = `		if (assistantMessageIndex === void 0 && mediaNormalizationFailed && hasOnlyFailureDisplay && runtimeOwnedText) return;
		// The runtime owns indexed reply text. An unlinked supplement owns only its media and failure cards.
		const supplementalContent = assistantMessageIndex !== void 0 ? persistedContentForAppend.filter((block) => block.type !== "text") : persistedContentForAppend;
		if (supplementalContent.length === 0) return;
		const appended = await appendAssistantTranscriptMessage({
			sessionKey,
			message: assistantMessageIndex !== void 0 ? "" : transcriptReply,
			content: supplementalContent,
			sessionId,`;

export function patchOpenClawChatMedia(openclawDir) {
  const pkg = JSON.parse(fs.readFileSync(path.join(openclawDir, 'package.json'), 'utf8'));
  if (pkg.name !== 'openclaw' || pkg.version !== VERSION) throw new Error(`${PATCH}: requires openclaw@${VERSION}`);
  const dist = path.join(openclawDir, 'dist');
  const files = fs.readdirSync(dist)
    .filter((name) => name.startsWith('chat-send-handler-') && /\.(?:mjs|js)$/.test(name))
    .map((name) => path.join(dist, name))
    .filter((file) => fs.readFileSync(file, 'utf8').includes('const appendWebchatAgentMediaTranscriptIfNeeded = async (payload) => {'));
  if (files.length !== 1) throw new Error(`${PATCH}: expected one chat send handler, found ${files.length}`);
  const file = files[0];
  const source = fs.readFileSync(file, 'utf8');
  const beforeCount = source.split(BEFORE).length - 1;
  const afterCount = source.split(AFTER).length - 1;
  if (beforeCount === 0 && afterCount === 1) return { status: 'clean', detail: 'already patched' };
  if (beforeCount !== 1 || afterCount !== 0) throw new Error(`${PATCH}: media transcript append anchor mismatch`);
  fs.writeFileSync(file, source.replace(BEFORE, AFTER));
  return { status: 'applied', detail: `${path.basename(file)}: media supplements preserve runtime-owned text` };
}
