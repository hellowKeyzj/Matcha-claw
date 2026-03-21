type MessageEventLike = { data?: unknown };
type CloseEventLike = { code?: number; reason?: unknown };

type WsWithOnApi = {
  on: (event: string, listener: (...args: unknown[]) => void) => void;
  send: (data: string) => void;
  close: (code?: number, reason?: string) => void;
};

type WsWithDomApi = {
  addEventListener: (type: string, listener: (event: unknown) => void) => void;
  send: (data: string) => void;
  close: (code?: number, reason?: string) => void;
};

type WebSocketLike = WsWithOnApi | WsWithDomApi;

type LoggerLike = {
  debug?: (message: string) => void;
  warn?: (message: string) => void;
};

type GatewayConfigLike = {
  gateway?: {
    port?: unknown;
    token?: unknown;
    auth?: {
      token?: unknown;
    };
  };
};

type BridgeRequest = {
  toolName: string;
  toolParams: Record<string, unknown>;
  agentId?: string;
  sessionKey?: string;
  requestTimeoutMs?: number;
  decisionTimeoutMs?: number;
};

export type NativeApprovalDecision =
  | { status: "approved"; approvalId: string; decision: string }
  | { status: "denied"; approvalId: string; decision: string }
  | { status: "timeout"; approvalId?: string; detail?: string }
  | { status: "error"; detail: string };

type GatewayEndpoint = {
  url: string;
  token: string;
};

const DEFAULT_GATEWAY_PORT = 18789;
const DEFAULT_REQUEST_TIMEOUT_MS = 5000;
const DEFAULT_DECISION_TIMEOUT_MS = 120000;
const GATEWAY_CLIENT_ID = "gateway-client";
const GATEWAY_CLIENT_MODE = "backend";
const GATEWAY_OPERATOR_SCOPES = ["operator.admin", "operator.approvals"];

function createWebSocket(url: string): WebSocketLike {
  const Ctor = (globalThis as { WebSocket?: new (url: string) => WebSocketLike }).WebSocket;
  if (typeof Ctor !== "function") {
    throw new Error("Global WebSocket is unavailable in current runtime");
  }
  return new Ctor(url);
}

function hasOnApi(ws: WebSocketLike): ws is WsWithOnApi {
  return typeof (ws as WsWithOnApi).on === "function";
}

function parseJsonFromUnknown(raw: unknown): unknown {
  if (typeof raw === "string") {
    return JSON.parse(raw);
  }
  if (raw instanceof Uint8Array) {
    return JSON.parse(Buffer.from(raw).toString());
  }
  if (raw instanceof ArrayBuffer) {
    return JSON.parse(Buffer.from(raw).toString());
  }
  if (raw && typeof raw === "object" && "toString" in raw && typeof raw.toString === "function") {
    return JSON.parse(raw.toString());
  }
  throw new Error("Unsupported websocket payload type");
}

function asNonEmptyString(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const normalized = value.trim();
  return normalized.length > 0 ? normalized : undefined;
}

function asPort(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value) && value > 0) {
    return Math.floor(value);
  }
  if (typeof value === "string") {
    const parsed = Number(value);
    if (Number.isFinite(parsed) && parsed > 0) {
      return Math.floor(parsed);
    }
  }
  return undefined;
}

function normalizeDecision(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const normalized = value.trim().toLowerCase();
  return normalized.length > 0 ? normalized : null;
}

function extractDecision(payload: unknown): string | null {
  if (!payload || typeof payload !== "object") return null;
  return normalizeDecision((payload as { decision?: unknown }).decision);
}

function summarizeToolParams(params: Record<string, unknown>): string {
  try {
    const serialized = JSON.stringify(params);
    if (typeof serialized !== "string") return "{}";
    if (serialized.length <= 400) return serialized;
    return `${serialized.slice(0, 400)}...`;
  } catch {
    return "{unserializable}";
  }
}

function buildApprovalCommandText(input: BridgeRequest): string {
  const summary = summarizeToolParams(input.toolParams);
  return `[security-core/non-exec] ${input.toolName} ${summary}`;
}

class GatewayRpcSession {
  private ws: WebSocketLike | null = null;
  private connected = false;
  private pending = new Map<
    string,
    {
      resolve: (value: unknown) => void;
      reject: (error: Error) => void;
      timeout: NodeJS.Timeout;
    }
  >();

  constructor(
    private readonly endpoint: GatewayEndpoint,
  ) {}

  private rejectAllPending(error: Error): void {
    this.pending.forEach((entry) => {
      clearTimeout(entry.timeout);
      entry.reject(error);
    });
    this.pending.clear();
  }

  async connect(timeoutMs: number): Promise<void> {
    if (this.connected) return;

    const ws = createWebSocket(this.endpoint.url);
    this.ws = ws;

    await new Promise<void>((resolve, reject) => {
      let challengeTimer: NodeJS.Timeout | null = setTimeout(() => {
        challengeTimer = null;
        reject(new Error("Gateway connect.challenge timeout"));
      }, timeoutMs);

      const cleanup = (): void => {
        if (challengeTimer) {
          clearTimeout(challengeTimer);
          challengeTimer = null;
        }
      };

      const rejectOnce = (error: Error): void => {
        cleanup();
        reject(error);
      };

      const connectRequestId = `connect-${crypto.randomUUID()}`;

      const handleMessage = (raw: unknown): void => {
        let message: unknown;
        try {
          message = parseJsonFromUnknown(raw);
        } catch {
          return;
        }

        if (
          !this.connected &&
          typeof message === "object" &&
          message !== null &&
          (message as { type?: unknown }).type === "event" &&
          (message as { event?: unknown }).event === "connect.challenge"
        ) {
          const nonce = asNonEmptyString((message as { payload?: { nonce?: unknown } }).payload?.nonce);
          if (!nonce) {
            rejectOnce(new Error("Gateway connect.challenge missing nonce"));
            return;
          }
          const frame = {
            type: "req",
            id: connectRequestId,
            method: "connect",
            params: {
              minProtocol: 3,
              maxProtocol: 3,
              client: {
                id: GATEWAY_CLIENT_ID,
                displayName: "Security Core",
                version: "0.1.0",
                platform: process.platform,
                mode: GATEWAY_CLIENT_MODE,
              },
              auth: {
                token: this.endpoint.token,
              },
              caps: [],
              role: "operator",
              scopes: GATEWAY_OPERATOR_SCOPES,
            },
          };
          ws.send(JSON.stringify(frame));
          return;
        }

        if (
          !this.connected &&
          typeof message === "object" &&
          message !== null &&
          (message as { type?: unknown }).type === "res" &&
          (message as { id?: unknown }).id === connectRequestId
        ) {
          const ok = (message as { ok?: unknown }).ok;
          if (ok === false || (message as { error?: unknown }).error) {
            const detail = JSON.stringify((message as { error?: unknown }).error ?? "connect rejected");
            rejectOnce(new Error(`Gateway connect rejected: ${detail}`));
            return;
          }
          this.connected = true;
          cleanup();
          resolve();
          return;
        }

        if (
          typeof message === "object" &&
          message !== null &&
          (message as { type?: unknown }).type === "res" &&
          typeof (message as { id?: unknown }).id === "string"
        ) {
          const id = (message as { id: string }).id;
          const pending = this.pending.get(id);
          if (!pending) return;
          this.pending.delete(id);
          clearTimeout(pending.timeout);
          const ok = (message as { ok?: unknown }).ok;
          if (ok === false || (message as { error?: unknown }).error) {
            const detail = JSON.stringify((message as { error?: unknown }).error ?? "request rejected");
            pending.reject(new Error(`Gateway RPC failed: ${detail}`));
            return;
          }
          pending.resolve((message as { payload?: unknown }).payload);
        }
      };

      const handleClose = (_code?: number, reason?: unknown): void => {
        const reasonText = reason?.toString() || "socket closed";
        if (!this.connected) {
          rejectOnce(new Error(`Gateway socket closed before connect: ${reasonText}`));
        }
        this.rejectAllPending(new Error(`Gateway socket closed: ${reasonText}`));
      };

      const handleError = (error: unknown): void => {
        if (!this.connected) {
          rejectOnce(error instanceof Error ? error : new Error(String(error)));
          return;
        }
        this.rejectAllPending(error instanceof Error ? error : new Error(String(error)));
      };

      if (hasOnApi(ws)) {
        ws.on("message", (raw) => handleMessage(raw));
        ws.on("close", (code, reason) => handleClose(code as number | undefined, reason));
        ws.on("error", (error) => handleError(error));
      } else {
        ws.addEventListener("message", (event) => handleMessage((event as MessageEventLike).data));
        ws.addEventListener("close", (event) => {
          const closeEvent = event as CloseEventLike;
          handleClose(closeEvent.code, closeEvent.reason);
        });
        ws.addEventListener("error", (error) => handleError(error));
      }
    });
  }

  async call<T>(method: string, params: unknown, timeoutMs: number): Promise<T> {
    if (!this.ws || !this.connected) {
      throw new Error("Gateway session not connected");
    }
    const requestId = crypto.randomUUID();
    return await new Promise<T>((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pending.delete(requestId);
        reject(new Error(`Gateway RPC timeout: ${method}`));
      }, timeoutMs);

      this.pending.set(requestId, {
        timeout,
        resolve: (value) => resolve(value as T),
        reject,
      });

      const frame = {
        type: "req",
        id: requestId,
        method,
        params,
      };
      try {
        this.ws?.send(JSON.stringify(frame));
      } catch (error) {
        clearTimeout(timeout);
        this.pending.delete(requestId);
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }

  close(): void {
    if (!this.ws) return;
    try {
      this.ws.close(1000, "security-core approval bridge done");
    } catch {
      // ignore close failures
    }
    this.ws = null;
    this.connected = false;
    this.rejectAllPending(new Error("Gateway session closed"));
  }
}

export class ApprovalBridgeService {
  constructor(
    private readonly options: {
      logger?: LoggerLike;
      loadConfig?: () => Promise<GatewayConfigLike>;
    },
  ) {}

  private async resolveEndpoint(): Promise<GatewayEndpoint> {
    const envToken = asNonEmptyString(process.env.OPENCLAW_GATEWAY_TOKEN)
      ?? asNonEmptyString(process.env.CLAWDBOT_GATEWAY_TOKEN);

    const loaded = this.options.loadConfig ? await this.options.loadConfig() : undefined;
    const gateway = loaded?.gateway;
    const token = envToken
      ?? asNonEmptyString(gateway?.auth?.token)
      ?? asNonEmptyString(gateway?.token);
    if (!token) {
      throw new Error("Gateway token unavailable for approval bridge");
    }
    const port = asPort(gateway?.port) ?? DEFAULT_GATEWAY_PORT;
    return {
      url: `ws://127.0.0.1:${port}/ws`,
      token,
    };
  }

  async requestNativeApproval(input: BridgeRequest): Promise<NativeApprovalDecision> {
    const requestTimeoutMs = input.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
    const decisionTimeoutMs = input.decisionTimeoutMs ?? DEFAULT_DECISION_TIMEOUT_MS;
    let session: GatewayRpcSession | null = null;
    try {
      const endpoint = await this.resolveEndpoint();
      session = new GatewayRpcSession(endpoint);
      await session.connect(requestTimeoutMs);

      const approvalId = crypto.randomUUID();
      const registrationPayload = await session.call<Record<string, unknown>>(
        "exec.approval.request",
        {
          id: approvalId,
          command: buildApprovalCommandText(input),
          commandArgv: [`tool:${input.toolName}`],
          host: "gateway",
          security: "allowlist",
          ask: "always",
          agentId: input.agentId ?? null,
          sessionKey: input.sessionKey ?? null,
          timeoutMs: decisionTimeoutMs,
          twoPhase: true,
        },
        requestTimeoutMs,
      );

      const resolvedApprovalId = asNonEmptyString(registrationPayload?.id) ?? approvalId;
      const preDecision = extractDecision(registrationPayload);
      const finalDecision = preDecision
        ?? extractDecision(
          await session.call<Record<string, unknown>>(
            "exec.approval.waitDecision",
            { id: resolvedApprovalId },
            decisionTimeoutMs + requestTimeoutMs,
          ),
        );

      if (!finalDecision) {
        return { status: "timeout", approvalId: resolvedApprovalId, detail: "decision is empty" };
      }
      if (finalDecision === "deny") {
        return { status: "denied", approvalId: resolvedApprovalId, decision: finalDecision };
      }
      if (
        finalDecision === "allow"
        || finalDecision === "allow-always"
        || finalDecision === "approve"
        || finalDecision === "approved"
      ) {
        return { status: "approved", approvalId: resolvedApprovalId, decision: finalDecision };
      }
      return { status: "error", detail: `Unsupported approval decision: ${finalDecision}` };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (/timeout|expired|not found/i.test(message)) {
        return { status: "timeout", detail: message };
      }
      return { status: "error", detail: message };
    } finally {
      session?.close();
    }
  }
}
