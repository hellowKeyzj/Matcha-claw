# Patch Notes — Matcha maintenance and compatibility-fork history

Matcha maintains and builds this source copy in `packages/openclaw-lark`. The package identity remains
`@larksuite/openclaw-lark` (private workspace package), with `pluginId=openclaw-lark` and `channelId=feishu`.
The development SDK is pinned to **OpenClaw 2026.9.3**, matching the repository root; this is not a claim
of validation against newer hosts.

## Historical compatibility patch

The following problem descriptions, change counts, and verification results were recorded by the
[`Leorand-dev/openclaw-lark-new`](https://github.com/Leorand-dev/openclaw-lark-new) compatibility fork of
[`larksuite/openclaw-lark`](https://github.com/larksuite/openclaw-lark), targeting OpenClaw **2026.9.4+**.
They are preserved as historical attribution, not current Matcha verification. Matcha has updated the
READMEs and delivery configuration described below.

## What was wrong (three independent problems)

1. **SDK root barrel removed in 2026.8.1.** `openclaw/plugin-sdk` no longer exists as an import
   target. The upstream plugin has 110 references to it across 109 files → the module fails to
   resolve and the plugin does not load. (Yes — the plugin has actually been broken since 2026.8.1;
   the "9.4 incompatibility" framing in many reports is the symptom, not the cause.)
2. **Node runtime floor tightened in 2026.9.4.** `engines.node` dropped support for Node 22 / 25.
   Hosts on those lines hit a SQLite-version safety error from the session layer at runtime.
3. **Session storage migrated to SQLite.** The old `loadSessionStore(jsonPath)` API no longer reads
   JSON files. Without migrating to `getSessionEntry` / `upsertSessionEntry`, the session-verbose
   override silently stops working (and so does the streaming-card footer token metrics, via a
   duck-typed `runtime.agent.session.loadSessionStore` call that `tsc` cannot catch).

A bonus fourth change is the CLI command declaration: 9.4 prefers parse-time
`descriptors` over the legacy `commands` shape. Both work in 9.4 but `descriptors` is the supported
pattern and is required by 9.5.

## Historical changes in the compatibility fork

- **109 files** — every `from 'openclaw/plugin-sdk'` rewritten to a specific subpath
  (`openclaw/plugin-sdk/core` and the few symbols that needed to be split out:
  `RuntimeEnv` → `runtime-env`, `ChannelMessageActionAdapter` → `channel-contract`,
  `ClawdbotConfig` renamed to `OpenClawConfig` because `ClawdbotConfig` no longer exists).
- **1 file** — `src/card/tool-use-config.ts`: switched from `loadSessionStore` /
  `resolveSessionStoreEntry` to `getSessionEntry`.
- **1 file** — `src/card/streaming-card-controller.ts`: `runtime.agent.session.getSessionEntry` is
  now preferred over the removed `loadSessionStore`, with the legacy read kept as a fallback for
  pre-9.x hosts.
- **1 file** — `index.ts`: `api.registerCli(..., { commands: [...] })` upgraded to
  `{ descriptors: [{ name, description, hasSubcommands }] }`.
- **2 mock files** — updated `openclaw/plugin-sdk/channel-runtime` imports in test mocks to
  `openclaw/plugin-sdk/channel-outbound` (the new home of `createReplyPrefixContext` /
  `createTypingCallbacks`).
- **1 test file** — `tests/tool-use-config.test.ts`: session-store fixtures are now seeded through
  `upsertSessionEntry` against a SQLite store (the old hand-written JSON fixtures are no longer
  readable).
- **1 file** — `package.json`: `engines.node` aligned to `>=24.16.0 <25 || >=26.1.0`,
  `peerDependencies.openclaw` `>=2026.8.1`, `openclaw.compat.pluginApi` `>=2026.8.1`,
  `devDependencies.openclaw` `^2026.9.4`.

Business logic is unchanged. 113 files / +381 / −316.

## Historical verification (reported by the compatibility fork; not rerun here)

| Check | Result |
| --- | --- |
| `tsc --noEmit` on `openclaw@2026.9.4` + Node v26.3.0 | **PASS** |
| `tsc --noEmit` on `openclaw@2026.8.1` (peer floor) | **PASS** |
| `vitest run` (53 files / 441 tests) | **PASS** |
| `eslint` (src+tests, same-scope baseline) | identical to upstream — **0 added** |
| `tsdown` build | **success** |
| `import dist/index.mjs` smoke | **plugin id = openclaw-lark** |
| Residual scan (old barrel / removed symbols / removed runtime duck-types) | **0** |

## Current Matcha build and delivery

Dependencies are installed through the root pnpm workspace and lockfile; the root uses
`"@larksuite/openclaw-lark": "workspace:*"`, not an npm release or GitHub install. Use Node
`>=24.16.0 <25 || >=26.1.0` and the root pnpm version. Run from the repository root:

```bash
pnpm install --frozen-lockfile
pnpm run build:openclaw-local-plugins -- openclaw-lark
pnpm --filter @larksuite/openclaw-lark run typecheck
pnpm --filter @larksuite/openclaw-lark run test
```

The managed builder runs `tsdown`, stages `build/openclaw-plugins/openclaw-lark`, and the existing
after-pack step copies it into `resources/openclaw-plugins/openclaw-lark`. Runtime delivery retains
`dist/index.mjs`, `dist/secret-contract-api.mjs`, the root `secret-contract-api.js`, and `skills/`.
The standalone `dist/config-schema.mjs` exports `FEISHU_CONFIG_JSON_SCHEMA` for Rust's existing channel
schema reader; channel ownership is unchanged. The official npm download, downloaded SDK-import
text patch, and `bin` wrapper invoking the official tools downloader are no longer delivery paths.

The commands above describe current checks, not recorded results. The historical verification table
does not establish build, typecheck, package-test, packaged-app, or live-channel success for Matcha.

## Provenance

- Upstream: <https://github.com/larksuite/openclaw-lark>
- Compatibility fork: <https://github.com/Leorand-dev/openclaw-lark-new>
- Current maintenance and delivery: Matcha, in this repository.
- License: MIT, retaining Copyright (c) 2026 Lark Technologies Pte. Ltd. (see [LICENSE](./LICENSE)).

## Detailed documentation

The compatibility fork referred to `openclaw-lark-fix/README.md` in its developer workspace for its
full evidence chain. That external historical reference is not current Matcha verification.