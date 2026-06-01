/**
 * Scrubbing functions for VaultHttpFetchTool.
 *
 * The cardinal rule: NO secret-derived string ever leaves this tool's
 * boundary in any field that would land in tool_result, jsonl, transcript
 * search, telemetry, or compact summaries. The scrub layer applies to:
 *   - response body (server might echo Authorization)
 *   - response headers (Authorization / X-Api-Key / Set-Cookie)
 *   - axios error messages (axios.AxiosError.config can carry the request
 *     headers — including the Authorization we just sent)
 *
 * Strategy: build all "derived forms" of the secret BEFORE the request, then
 * apply scrubAllSecretForms to every byte that crosses the tool boundary.
 *
 * Derived forms covered:
 *   - raw secret value
 *   - 'Bearer <secret>'
 *   - <secret> base64-encoded (for Basic-style payloads)
 *   - 'Basic <base64>' full header value
 *
 * Custom auth_header_name puts the raw secret as the header value, which is
 * already covered by the raw-secret form.
 */
/**
 * Compute every form the secret could appear in across response body /
 * headers / error message.
 *
 * L7 fix: returns `[]` (empty) when secret is shorter than MIN_SCRUB_LENGTH
 * — scrubbing a too-short pattern is worse than not scrubbing. Caller
 * should guard `if (secret && secret.length >= MIN_SCRUB_LENGTH)` before
 * trusting the result is non-empty. The previous JSDoc claimed "always
 * non-empty" which was inaccurate.
 *
 * M3 fix (codecov-100 audit #6): for short secrets (4-7 chars) we omit
 * the bare-base64 form because its 7-8 char encoding is short enough to
 * collide with unrelated tokens in the response body and produce
 * spurious [REDACTED] markers. We still emit raw + Bearer + Basic-base64
 * because those have a longer/more-specific match shape.
 *
 * Returned forms are sorted longest-first so callers don't need to re-sort.
 */
export declare function buildDerivedSecretForms(
  secret: string,
): readonly string[]
/**
 * Replace every occurrence of any derived secret form in `s` with [REDACTED].
 *
 * M7 fix: forms array is pre-sorted longest-first by buildDerivedSecretForms,
 * so we no longer allocate a sorted copy on every call. Also added a
 * `s.length >= form.length` fast-path before `includes()` to skip
 * impossible-match work, and the `includes()` check itself is the fast path
 * that lets us skip the split/join allocation for clean bodies.
 */
export declare function scrubAllSecretForms(
  s: string,
  forms: readonly string[],
): string
/**
 * Sanitize response headers: redact sensitive header names entirely, and
 * scrub any remaining headers' values for secret echo.
 */
export declare function scrubResponseHeaders(
  headers: unknown,
  forms: readonly string[],
): Record<string, string>
/**
 * Truncate a string to at most `maxBytes` UTF-8 bytes, returning a value that
 * is still valid UTF-8 (no half-encoded code points).
 *
 * H1 fix (codecov-100 audit): the previous code used `String#slice(0, 80)`
 * which counts UTF-16 *code units*. With multi-byte UTF-8 (CJK, emoji,
 * combining marks) an 80-char slice can balloon to 240+ bytes — violating
 * the analytics field's byte-cap contract. We walk the byte buffer and
 * back off to the start of the last complete UTF-8 code point. (We also
 * walk back any combining-mark continuation bytes that depend on a
 * just-truncated lead byte; this is handled implicitly by the
 * leading-byte check since UTF-8 continuation bytes are 0b10xxxxxx.)
 *
 * Empty / null-ish inputs return ''.
 */
export declare function truncateToBytes(input: string, maxBytes: number): string
/**
 * Convert an axios / fetch error into a safe summary string. NEVER stringify
 * the raw error: axios.AxiosError carries .config.headers which contains the
 * Authorization we just sent. Build a synthetic message and scrub it.
 */
export declare function scrubAxiosError(
  e: unknown,
  forms: readonly string[],
): string
