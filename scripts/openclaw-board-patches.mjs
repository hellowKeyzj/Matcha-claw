import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';

const VERSION = '2026.9.3';
const PATCH = 'matcha-native-board-view-v1';
const read = (file) => fs.readFileSync(file, 'utf8');
const digest = (source) => createHash('sha256').update(source).digest('hex');

function replace(source, before, after) {
  if (source.split(after).length === 2) return source;
  if (source.includes(after) || source.split(before).length !== 2) {
    throw new Error(`${PATCH}: source anchor mismatch: ${before.slice(0, 100)}`);
  }
  return source.replace(before, after);
}

function locate(dist, prefix, markers) {
  const files = fs.readdirSync(dist).filter((name) => name.startsWith(prefix) && /\.(?:mjs|js)$/.test(name))
    .map((name) => path.join(dist, name)).filter((file) => markers.every((marker) => read(file).includes(marker)));
  if (files.length !== 1) throw new Error(`${PATCH}: expected one ${prefix} source, found ${files.length}`);
  return files[0];
}

export function patchBoardClientInfo(source) {
  return replace(source, '\tINLINE_WIDGETS: "inline-widgets",', '\tBOARD_VIEW: "board-view",\n\tINLINE_WIDGETS: "inline-widgets",');
}

export function patchDashboardBoardCommand(source) {
  // Search seals this shared bundle first. Verify before changing it, then preserve its seal.
  const stamp = source.match(/^\/\/ matcha-native-searxng-v3 sha256=([a-f0-9]{64})\n/);
  if (stamp && digest(source.slice(stamp[0].length)) !== stamp[1]) throw new Error(`${PATCH}: native search source seal mismatch`);
  let body = stamp ? source.slice(stamp[0].length) : source;
  const imports = [...body.matchAll(/^import \{ ([^\n]+) \} from "(\.\/client-info-[^"/]+\.mjs)";$/gm)];
  if (imports.length !== 1) throw new Error(`${PATCH}: expected one native client-info import`);
  const [line, bindings, specifier] = imports[0];
  if (!bindings.split(', ').includes('a as hasGatewayClientCap')) {
    body = replace(body, line, `import { a as hasGatewayClientCap, ${bindings} } from "${specifier}";`);
  }
  // Caps declare a consumer; the native broadcaster still owns authorization and session visibility.
  body = replace(body,
    'context.getClientConnIds?.((client) => client.connect.client.id === GATEWAY_CLIENT_IDS.CONTROL_UI)',
    'context.getClientConnIds?.((client) => client.connect.client.id === GATEWAY_CLIENT_IDS.CONTROL_UI || hasGatewayClientCap(client.connect.caps, GATEWAY_CLIENT_CAPS.BOARD_VIEW))');
  return stamp ? `// matcha-native-searxng-v3 sha256=${digest(body)}\n${body}` : body;
}

export function patchBoardEventCatalog(source) {
  return replace(source, '\t"ui.command",', '\t"ui.command",\n\t"board.changed",\n\t"board.command",');
}

export function patchSandboxFileParent(source) {
  source = replace(source, 'function buildSandboxHostProxyHtml(csp) {', 'function buildSandboxHostProxyHtml(csp, fileParent = false) {');
  source = replace(source, `  let hostOrigin;
  try {
    const referrer = new URL(document.referrer);
    if (referrer.protocol !== "http:" && referrer.protocol !== "https:") throw new Error();
    hostOrigin = referrer.origin;
  } catch { throw new Error("invalid MCP App sandbox parent"); }`, `  const fileParent = \${fileParent};
  const nonce = fileParent ? /^#matcha-sandbox=([a-f0-9]{64})$/.exec(window.location.hash)?.[1] : undefined;
  let hostOrigin;
  let hostPort;
  if (fileParent) {
    if (!nonce) throw new Error("invalid MCP App sandbox parent capability");
  } else {
    try {
      const referrer = new URL(document.referrer);
      if (referrer.protocol !== "http:" && referrer.protocol !== "https:") throw new Error();
      hostOrigin = referrer.origin;
    } catch { throw new Error("invalid MCP App sandbox parent"); }
  }
  const postToHost = (data, ports = []) => {
    if (fileParent) hostPort?.postMessage(data, ports);
    else window.parent.postMessage(data, hostOrigin, ports);
  };`);
  source = replace(source, `  window.addEventListener("message", (event) => {
    if (event.source === window.parent) {
      if (event.origin !== hostOrigin) return;`, `  const receiveHostMessage = (event) => {`);
  source = replace(source, `            window.parent.postMessage({
              jsonrpc: "2.0",
              method: "ui/notifications/sandbox-resource-loaded",
              params: { renderId: params.renderId },
            }, hostOrigin);`, `            postToHost({
              jsonrpc: "2.0",
              method: "ui/notifications/sandbox-resource-loaded",
              params: { renderId: params.renderId },
            });`);
  source = replace(source, `      inner.contentWindow?.postMessage(event.data, "*");
      return;
    }
    if (event.source === inner.contentWindow) {`, `      inner.contentWindow?.postMessage(event.data, "*");
  };
  const notifyReady = () => postToHost({
    jsonrpc: "2.0",
    method: "ui/notifications/sandbox-proxy-ready",
    params: { sandboxUrl: window.location.href },
  });
  window.addEventListener("message", (event) => {
    if (event.source === window.parent) {
      if (!fileParent) {
        if (event.origin === hostOrigin) receiveHostMessage(event);
        return;
      }
      // Opaque file parents need a one-use capability, never a null-origin allowlist.
      if (!hostPort && event.origin === "null" && event.data?.type === "matcha:sandbox-connect" && event.data.nonce === nonce && event.ports.length === 1) {
        hostPort = event.ports[0];
        hostPort.onmessage = receiveHostMessage;
        hostPort.start();
        notifyReady();
      } else {
        for (const port of event.ports) port.close();
      }
      return;
    }
    if (event.source === inner.contentWindow) {`);
  source = replace(source, '          const nextInner = createInner();', '          const nextInner = createInner();\n          if (params.sandbox === "strict") nextInner.setAttribute("sandbox", "");');
  source = replace(source, '          window.parent.postMessage(event.data, hostOrigin, [port]);', '          postToHost(event.data, [port]);');
  source = replace(source, '      window.parent.postMessage(event.data, hostOrigin);', '      postToHost(event.data);');
  source = replace(source, `  window.parent.postMessage({
    jsonrpc: "2.0",
    method: "ui/notifications/sandbox-proxy-ready",
    params: { sandboxUrl: window.location.href },
  }, hostOrigin);`, `  if (!fileParent) notifyReady();
  window.addEventListener("pagehide", () => hostPort?.close(), { once: true });`);
  source = replace(source, 'function buildSandboxHostContentSecurityPolicy(csp) {', 'function buildSandboxHostContentSecurityPolicy(csp, fileParent = false) {');
  return replace(source, '\t\t"frame-ancestors http: https:"', '\t\tfileParent ? "frame-ancestors file:" : "frame-ancestors http: https:"');
}

export function patchSandboxHttpFileParent(source) {
  source = replace(source, `\tlet csp;
\ttry {
\t\tcsp = decodeSandboxHostCsp(url.searchParams.get("csp"));`, `\tlet csp;
\tlet fileParent = false;
\ttry {
\t\tconst parents = url.searchParams.getAll("matcha_parent");
\t\tif (parents.length && (parents.length !== 1 || parents[0] !== "file")) throw new Error("invalid MCP App sandbox parent");
\t\tfileParent = parents.length === 1;
\t\tcsp = decodeSandboxHostCsp(url.searchParams.get("csp"));`);
  source = replace(source,
    'res.setHeader("Content-Security-Policy", buildSandboxHostContentSecurityPolicy(csp));',
    'res.setHeader("Content-Security-Policy", buildSandboxHostContentSecurityPolicy(csp, fileParent));');
  return replace(source, '\tconst html = buildSandboxHostProxyHtml(csp);', '\tconst html = buildSandboxHostProxyHtml(csp, fileParent);');
}

export function patchCanvasDisplayProjection(source) {
  source = replace(source, 'function coerceCanvasPreview(record) {', `function isCanvasDocumentViewId(value) {
\treturn typeof value === "string" && value.length > 0 && value.length <= 256 && /^(?!\\.{1,2}$)[A-Za-z0-9._-]+$/.test(value);
}
function coerceCanvasPreview(record) {`);
  source = replace(source, '\tif (viewUrl) return {', `\tif (record.mcpApp === void 0 && !viewUrl && isCanvasDocumentViewId(viewId)) return {
\t\tkind: "canvas",
\t\tsurface,
\t\trender: "url",
\t\tviewId,
\t\t...title ? { title } : {},
\t\t...preferredHeight ? { preferredHeight } : {},
\t\t...sandbox ? { sandbox } : {},
\t\t...boardWidgetName ? { boardWidgetName } : {}
\t};
\tif (viewUrl) return {`);
  source = replace(source,
    '\treturn coerceCanvasPreview(asOptionalRecord(details?.mcpAppPreview));',
    '\treturn coerceCanvasPreview(asOptionalRecord(details?.mcpAppPreview) ?? (details?.kind === "canvas" && details.mcpApp === void 0 ? details : void 0));');
  return replace(source, `\t\tmcpApp: preview.mcpApp
\t};
\treturn {
\t\tdetails: Object.keys(projected).length > 0 ? projected : void 0,`, `\t\tmcpApp: preview.mcpApp
\t};
\telse if (preview && !preview.mcpApp && (asOptionalRecord(record.mcpAppPreview) ?? record).mcpApp === void 0 && isCanvasDocumentViewId(preview.viewId)) projected.mcpAppPreview = {
\t\tkind: "canvas",
\t\tview: {
\t\t\tid: preview.viewId,
\t\t\t...preview.title ? { title: preview.title } : {},
\t\t\t...preview.boardWidgetName ? { boardWidgetName: preview.boardWidgetName } : {}
\t\t},
\t\tpresentation: {
\t\t\ttarget: preview.surface,
\t\t\t...preview.title ? { title: preview.title } : {},
\t\t\t...preview.preferredHeight ? { preferred_height: preview.preferredHeight } : {},
\t\t\t...preview.sandbox ? { sandbox: preview.sandbox } : {}
\t\t}
\t};
\treturn {
\t\tdetails: Object.keys(projected).length > 0 ? projected : void 0,`);
}

export function patchBoardValidationReason(source) {
  return replace(source, `\tconstructor(code, message) {
\t\tsuper(message);
\t\tthis.name = "BoardValidationError";
\t\tthis.code = code;
\t}`, `\tconstructor(code, message, reason) {
\t\tsuper(message);
\t\tthis.name = "BoardValidationError";
\t\tthis.code = code;
\t\tthis.reason = reason;
\t}`);
}

export function patchBoardTicketVerdict(source) {
  source = replace(source, `function verifyBoardViewTicket(value, options = {}) {
\tconst nowMs = options.nowMs ?? Date.now();
\tif (!Number.isSafeInteger(nowMs) || value.length > BOARD_VIEW_TICKET_MAX_LENGTH) return;
\tconst parts = value.split(".");
\tif (parts.length !== 3 || parts[0] !== "v1") return;
\tconst [, payload, signature] = parts;
\tif (!payload || !signature) return;
\tconst expectedSignature = signTicketPayload(payload, ticketSecret);
\tif (!safeEqualSecret(signature, expectedSignature)) return;
\tlet claims;
\ttry {
\t\tclaims = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
\t} catch {
\t\treturn;
\t}
\tif (!isValidClaims(claims) || claims.expiresAtMs <= nowMs) return;
\treturn claims;
}`, `function verifyBoardViewTicketResult(value, options = {}) {
\tconst nowMs = options.nowMs ?? Date.now();
\tif (!Number.isSafeInteger(nowMs) || value.length > BOARD_VIEW_TICKET_MAX_LENGTH) return { reason: "invalid" };
\tconst parts = value.split(".");
\tif (parts.length !== 3 || parts[0] !== "v1") return { reason: "invalid" };
\tconst [, payload, signature] = parts;
\tif (!payload || !signature) return { reason: "invalid" };
\tconst expectedSignature = signTicketPayload(payload, ticketSecret);
\tif (!safeEqualSecret(signature, expectedSignature)) return { reason: "invalid" };
\tlet claims;
\ttry {
\t\tclaims = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
\t} catch {
\t\treturn { reason: "invalid" };
\t}
\tif (!isValidClaims(claims)) return { reason: "invalid" };
\tif (claims.expiresAtMs <= nowMs) return { reason: "expired" };
\treturn { claims };
}
function verifyBoardViewTicket(value, options = {}) {
\treturn verifyBoardViewTicketResult(value, options).claims;
}`);
  return replace(source, 'export { createBoardViewTicket as a,', 'export { verifyBoardViewTicketResult, createBoardViewTicket as a,');
}

export function patchBoardWidgetViewReasons(source) {
  source = replace(source, 'import { c as verifyBoardViewTicket, o as requireBoardViewTicketAuthority }', 'import { verifyBoardViewTicketResult, o as requireBoardViewTicketAuthority }');
  source = replace(source, `\tconst claims = verifyBoardViewTicket(ticket, options);
\tif (!claims) throw new BoardValidationError("invalid_operation", "board widget view ticket is invalid");`, `\tconst result = verifyBoardViewTicketResult(ticket, options);
\tif (!result.claims) throw new BoardValidationError("invalid_operation", "board widget view ticket is invalid", result.reason);
\tconst claims = result.claims;`);
  for (const condition of [
    '!document || document.grantState !== "none" && document.grantState !== "granted" || document.revision !== claims.revision || document.viewGeneration !== claims.viewGeneration',
    '!("source" in document) || document.pluginKind !== claims.pluginFrame.pluginKind',
    '!("html" in document)',
  ]) {
    source = replace(source,
      `if (${condition}) throw new BoardValidationError("invalid_operation", "board widget view ticket is stale");`,
      `if (${condition}) throw new BoardValidationError("invalid_operation", "board widget view ticket is stale", "stale");`);
  }
  return replace(source,
    'if (!registration || !resourceUrls) throw new BoardValidationError("invalid_operation", "board widget content kind is unavailable");',
    'if (!registration || !resourceUrls) throw new BoardValidationError("invalid_operation", "board widget content kind is unavailable", "unavailable");');
}

export function patchBoardRpcReasons(source) {
  source = replace(source, `function respondBoardError(error, respond) {
\tif (error instanceof BoardGatewayUnavailableError) {
\t\trespond(false, void 0, errorShape(ErrorCodes.UNAVAILABLE, error.message));
\t\treturn;
\t}
\tif (error instanceof BoardValidationError || error instanceof BoardEventPayloadError) {
\t\trespond(false, void 0, errorShape(ErrorCodes.INVALID_REQUEST, error.message));
\t\treturn;
\t}
\trespond(false, void 0, errorShape(ErrorCodes.UNAVAILABLE, String(error)));
}`, `function respondBoardError(error, respond) {
\tconst reason = error instanceof BoardGatewayUnavailableError ? "unavailable"
\t\t: error instanceof BoardEventPayloadError ? "invalid"
\t\t: error instanceof BoardValidationError && ["invalid", "forbidden", "stale", "expired", "unavailable", "unknown"].includes(error.reason) ? error.reason : "unknown";
\tconst options = { details: { reason } };
\tif (error instanceof BoardGatewayUnavailableError) {
\t\trespond(false, void 0, errorShape(ErrorCodes.UNAVAILABLE, error.message, options));
\t\treturn;
\t}
\tif (error instanceof BoardValidationError || error instanceof BoardEventPayloadError) {
\t\trespond(false, void 0, errorShape(ErrorCodes.INVALID_REQUEST, error.message, options));
\t\treturn;
\t}
\trespond(false, void 0, errorShape(ErrorCodes.UNAVAILABLE, String(error), options));
}`);
  for (const [expression, reason] of [
    ['"invalid_operation", `board widget tool is not granted: ${capability}`', 'forbidden'],
    ['"invalid_operation", `board widget data binding is not allowed: ${bindingId}`', 'forbidden'],
    ['"invalid_operation", `board widget action verb is not allowed: ${actionId}`', 'forbidden'],
    ['"invalid_operation", `widget kind ${JSON.stringify(requestParams.content.contentKind)} is unavailable; enable the plugin that provides it and retry`', 'unavailable'],
  ]) {
    source = replace(source, `new BoardValidationError(${expression})`, `new BoardValidationError(${expression}, "${reason}")`);
  }
  return replace(source,
    'if (!widget || widget.contentKind !== "mcp-app" || widget.revision !== boardParams.revision || widget.instanceId !== boardParams.instanceId || !document || document.revision !== boardParams.revision || document.instanceId !== boardParams.instanceId) throw new BoardValidationError("not_found", `board MCP App widget not found: ${boardParams.name}`);',
    `if (!widget || widget.contentKind !== "mcp-app" || !document) throw new BoardValidationError("not_found", \`board MCP App widget not found: \${boardParams.name}\`);
\t\t\t\tif (widget.revision !== boardParams.revision || widget.instanceId !== boardParams.instanceId || document.revision !== boardParams.revision || document.instanceId !== boardParams.instanceId) throw new BoardValidationError("not_found", \`board MCP App widget not found: \${boardParams.name}\`, "stale");`);
}

export function patchOpenClawBoard(openclawDir) {
  const pkg = JSON.parse(read(path.join(openclawDir, 'package.json')));
  if (pkg.name !== 'openclaw' || pkg.version !== VERSION) throw new Error(`${PATCH}: requires openclaw@${VERSION}`);
  const dist = path.join(openclawDir, 'dist');
  const clients = locate(dist, 'client-info-', ['const GATEWAY_CLIENT_CAPS = {', 'function hasGatewayClientCap(caps, cap)']);
  const dashboard = locate(dist, 'openclaw-tools-', ['function emitBoardCommand(params, resolveGatewayContext)', 'context.broadcastToConnIds("board.command", params, connIds);']);
  const server = locate(dist, 'server-start-', ['function createGatewayBroadcaster(params)', 'function createSandboxHostHttpServer(', 'const ensureSandboxHostPort = async () => {']);
  const events = locate(dist, 'server-methods-list-', ['const GATEWAY_EVENTS = [']);
  const sandbox = locate(dist, 'sandbox-host-', ['function buildSandboxHostProxyHtml(csp', 'ui/notifications/sandbox-proxy-ready', 'openclaw:widget-bridge-port-offer', 'openclaw:widget-prompt-offer']);
  const mcp = locate(dist, 'mcp-app-', ['const mcpAppHandlers = {', '"mcp.app.view":', '"mcp.app.updateModelContext":', 'context.ensureSandboxHostPort?.()']);
  const canvas = locate(dist, 'canvas-', ['"canvas.document.view":', 'context.ensureSandboxHostPort?.()', 'sandboxUrl: buildSandboxHostPath({ blockDescendantFrames: true })']);
  const projection = locate(dist, 'chat-display-projection.canvas-', ['function projectToolResultDetails(details, maxChars)', 'function coerceCanvasPreview(record)']);
  const layout = locate(dist, 'board-layout-', ['var BoardValidationError = class extends Error {']);
  const ticket = locate(dist, 'board-view-ticket-', ['function verifyBoardViewTicket(value, options = {})', 'function requireBoardViewTicketAuthority(claims, gatewayContext)']);
  const widgetView = locate(dist, 'board-widget-view-', ['function resolveAuthorizedBoardWidgetView(store, ticket, options = {})']);
  const board = locate(dist, 'board-', ['function respondBoardError(error, respond)', '"board.widget.appView":']);
  for (const file of [server, canvas]) {
    if (!read(file).includes(`from "./${path.basename(sandbox)}"`)) throw new Error(`${PATCH}: native sandbox resource import missing in ${path.basename(file)}`);
  }
  const edits = [
    [clients, patchBoardClientInfo],
    [dashboard, patchDashboardBoardCommand],
    [server, patchSandboxHttpFileParent],
    [events, patchBoardEventCatalog],
    [sandbox, patchSandboxFileParent],
    [projection, patchCanvasDisplayProjection],
    [layout, patchBoardValidationReason],
    [ticket, patchBoardTicketVerdict],
    [widgetView, patchBoardWidgetViewReasons],
    [board, patchBoardRpcReasons],
  ].map(([file, transform]) => {
    const before = read(file);
    return { file, before, after: transform(before) };
  });
  const changed = edits.filter(({ before, after }) => before !== after);
  for (const { file, after } of changed) fs.writeFileSync(file, after);
  return {
    status: changed.length ? 'applied' : 'clean',
    detail: `OpenClaw ${VERSION} board-view events, typed reasons and file-parent sandbox capability; native MCP/Canvas resources verified (${[sandbox, mcp, canvas].map((file) => path.basename(file)).join(', ')})`,
  };
}
