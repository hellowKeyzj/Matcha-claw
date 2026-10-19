// Adapted from OpenClaw. Copyright (c) 2026 OpenClaw Foundation.
// SPDX-License-Identifier: MIT; see LICENSE and NOTICE in this directory.

// Browser-safe redaction for tool details rendered by the Control UI.
import { sliceUtf16Safe } from "./text";
import { DEFAULT_REDACT_PATTERNS } from "./redact-patterns";

const URL_QUERY_PAIR_RE = /([?&])([^=&#\s]+)=([^&#\s"'<>]+)/gu;
const SECRET_DETAIL_PATTERNS = DEFAULT_REDACT_PATTERNS.map(
  (source) => new RegExp(...parseRedactPatternSource(source)),
);
const SENSITIVE_TEXT_PATTERNS: Array<[RegExp, string]> = [
  [/\b(Authorization|Cookie|Set-Cookie)\s*:\s*[^\n\r]+/gi, "$1: [redacted]"],
  [/\b(Bearer\s+)[A-Za-z0-9._~+/=-]{12,}/gi, "$1[redacted]"],
  [
    /\b(api[_.-]?key|token|secret|password|passwd|authorization)\b(["'])(\s*:\s*)"(?:\\.|[^"\\\r\n])*"/gi,
    '$1$2$3"[redacted]"',
  ],
  [
    /\b(api[_.-]?key|token|secret|password|passwd|authorization)\b(["'])(\s*:\s*)'(?:\\.|[^'\\\r\n])*'/gi,
    "$1$2$3'[redacted]'",
  ],
  [
    /\b(api[_.-]?key|token|secret|password|passwd|authorization)\b(\s*[:=]\s*)["']?[^"',\s}]+/gi,
    "$1$2[redacted]",
  ],
  [
    /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
    "[redacted private key]",
  ],
  [
    /(^|[\s"'`=])(?:\/Users\/|\/home\/|\/var\/folders\/|[A-Za-z]:\\)[^\s"'`,;]+/g,
    "$1[redacted path]",
  ],
];

function redactToken(value: string): string {
  if (value.length <= 10) {
    return "***";
  }
  // A 6/4-shaped hint is intentionally idempotent: every non-separator
  // character is already inside the visible prefix or suffix budget.
  return `${sliceUtf16Safe(value, 0, 6)}...${sliceUtf16Safe(value, -4)}`;
}

function redactMatch({ match, groups, input, offset }: RedactMatch): string {
  const followingText = offset < 0 ? "" : input.slice(offset + match.length);
  if (match.includes("PRIVATE KEY-----")) {
    return redactPemBlock(match, "...redacted...");
  }
  const token = [...groups].reverse().find((group) => typeof group === "string" && group.length > 0) ?? match;
  // Replacement-template syntax can make a later pattern see only the leading `$` after an
  // earlier pattern has already masked the value. Preserve that literal shell marker.
  if (token === "$" && followingText.startsWith("`")) {
    return match;
  }
  const masked = redactToken(token);
  if (token === match) {
    return masked;
  }
  const tokenOffset = match.lastIndexOf(token);
  if (tokenOffset < 0) {
    return "***";
  }
  return `${match.slice(0, tokenOffset)}${masked}${match.slice(tokenOffset + token.length)}`;
}

function redactUrlQueryPairs(detail: string): string {
  return detail.replace(URL_QUERY_PAIR_RE, (match, boundary: string, key: string, value: string) =>
    isSensitiveUrlQueryParamName(key) ? `${boundary}${key}=${redactToken(value)}` : match,
  );
}

export function redactToolDetail(detail: string): string {
  let redacted = redactUrlQueryPairs(detail);
  for (const pattern of SECRET_DETAIL_PATTERNS) {
    redacted = redacted.replace(pattern, (...args: unknown[]) =>
      redactMatch(readRedactMatch(args)),
    );
  }
  return SENSITIVE_TEXT_PATTERNS.reduce(
    (text, [pattern, replacement]) => text.replace(pattern, replacement),
    redacted,
  );
}

export const redactToolPayloadText = redactToolDetail;

// Browser-safe pattern mechanics; callers retain compilation and masking policy.
export function parseRedactPatternSource(raw: string): [source: string, flags: string] {
  const literal = raw.match(/^\/(.+)\/([gimsuy]*)$/);
  if (!literal) {
    return [raw, "gi"];
  }
  const source = literal[1] ?? "";
  const flags = literal[2] ?? "";
  return [source, flags.includes("g") ? flags : `${flags}g`];
}

export function readRedactMatch(args: unknown[]) {
  const hasNamedGroups =
    args.length > 0 && typeof args[args.length - 1] === "object" && args[args.length - 1] !== null;
  const inputIndex = hasNamedGroups ? args.length - 2 : args.length - 1;
  const offsetIndex = inputIndex - 1;
  const match = typeof args[0] === "string" ? args[0] : "";
  const groups = args
    .slice(1, offsetIndex)
    .map((value) => (typeof value === "string" ? value : ""));
  const offset = typeof args[offsetIndex] === "number" ? args[offsetIndex] : -1;
  const input = typeof args[inputIndex] === "string" ? args[inputIndex] : "";
  return { match, groups, input, offset };
}

export type RedactMatch = ReturnType<typeof readRedactMatch>;

export function redactPemBlock(block: string, marker: string): string {
  const lines = block.split(/\r?\n/).filter(Boolean);
  if (lines.length < 2) {
    return "***";
  }
  return `${lines[0]}\n${marker}\n${lines[lines.length - 1]}`;
}

const SENSITIVE_URL_QUERY_PARAM_NAMES = new Set([
  "token",
  "key",
  "api_key",
  "apikey",
  "secret",
  "access_token",
  "auth_token",
  "password",
  "pass",
  "passwd",
  "auth",
  "jwt",
  "session",
  "id_token",
  "code",
  "client_secret",
  "app_secret",
  "hook_token",
  "refresh_token",
  "signature",
  "x_amz_signature",
  "x_amz_security_token",
  "private_key",
  "credential",
  "authorization",
  // Common signed/API gateway aliases that do not contain an existing secret-name marker.
  "sig",
  "x_api_key",
  "x_access_token",
  "x_auth_token",
]);

const URL_QUERY_NAME_SEPARATOR_RE = /[\p{C}\p{Z}\u115F\u1160\u3164\uFFA0+]/gu;

const SUFFIXED_OR_SCOPED_TOKEN_QUERY_PARAM_RE = /(?:^|_)token(?:_[a-f0-9]{16,})?$/u;

const MAX_NESTED_URL_REDACTION_DEPTH = 8;

function normalizeUrlQueryParamName(name: string): {
  value: string;
  unresolvedEncoding: boolean;
} {
  let current = name.replace(URL_QUERY_NAME_SEPARATOR_RE, "");
  for (let depth = 0; depth <= MAX_NESTED_URL_REDACTION_DEPTH; depth += 1) {
    let decoded: string;
    try {
      decoded = decodeURIComponent(current).replace(URL_QUERY_NAME_SEPARATOR_RE, "");
    } catch {
      return {
        value: current.trim().toLowerCase().replaceAll("-", "_"),
        unresolvedEncoding: current.includes("%"),
      };
    }
    if (decoded === current) {
      return {
        value: current.trim().toLowerCase().replaceAll("-", "_"),
        unresolvedEncoding: false,
      };
    }
    current = decoded;
  }
  return {
    value: current.trim().toLowerCase().replaceAll("-", "_"),
    unresolvedEncoding: current.includes("%"),
  };
}

export function isSensitiveUrlQueryParamName(name: string): boolean {
  const normalized = normalizeUrlQueryParamName(name);
  return (
    normalized.unresolvedEncoding ||
    SENSITIVE_URL_QUERY_PARAM_NAMES.has(normalized.value) ||
    SUFFIXED_OR_SCOPED_TOKEN_QUERY_PARAM_RE.test(normalized.value)
  );
}
