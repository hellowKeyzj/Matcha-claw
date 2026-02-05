# Commit 11: Fix OpenClaw Submodule Integration

## Overview

Fixed the OpenClaw submodule configuration to use the official GitHub repository instead of a local path, and added automatic token generation for gateway authentication.

## Changes Made

### 1. Fixed Submodule URL

Updated `.gitmodules` to point to the official GitHub repository:

**Before:**
```
[submodule "openclaw"]
    path = openclaw
    url = /Users/guoyuliang/Project/openclaw
```

**After:**
```
[submodule "openclaw"]
    path = openclaw
    url = https://github.com/openclaw/openclaw.git
```

Checked out stable version `v2026.2.3`.

### 2. Added Gateway Token Management

**electron/utils/store.ts:**
- Added `gatewayToken` to `AppSettings` interface
- Added `generateToken()` function to create random tokens (`clawx-xxxxxxxxxxxx`)
- Token is auto-generated on first launch and persisted

### 3. Updated Gateway Manager

**electron/gateway/manager.ts:**
- Import `getSetting` from store
- Get or generate gateway token on startup
- Pass `--token` argument when spawning gateway process
- Set `OPENCLAW_GATEWAY_TOKEN` environment variable
- Include token in WebSocket URL for authentication (`?auth=token`)
- Added `--dev` and `--allow-unconfigured` flags for first-time setup

## Technical Details

### Token Flow

```
┌─────────────────┐     ┌─────────────────┐     ┌─────────────────┐
│  ClawX Start    │────▶│  Get/Generate   │────▶│  Store Token    │
│                 │     │  Token          │     │  (electron-     │
│                 │     │                 │     │   store)        │
└─────────────────┘     └─────────────────┘     └─────────────────┘
         │
         ▼
┌─────────────────┐     ┌─────────────────┐
│  Start Gateway  │────▶│  Connect WS     │
│  --token xxx    │     │  ?auth=xxx      │
└─────────────────┘     └─────────────────┘
```

### Gateway Startup Command

**Production mode:**
```bash
node openclaw.mjs gateway run --port 18789 --token <token> --dev --allow-unconfigured
```

**Development mode:**
```bash
pnpm run dev gateway run --port 18789 --token <token> --dev --allow-unconfigured
```

### Environment Variables

- `OPENCLAW_GATEWAY_TOKEN`: Gateway authentication token
- `OPENCLAW_SKIP_CHANNELS`: Skip channel auto-connect (faster startup)
- `CLAWDBOT_SKIP_CHANNELS`: Legacy skip channels flag

## Files Modified

| File | Changes |
|------|---------|
| `.gitmodules` | Updated URL to GitHub repo |
| `openclaw` | Submodule updated to v2026.2.3 |
| `electron/utils/store.ts` | Added gatewayToken setting and generateToken() |
| `electron/gateway/manager.ts` | Token auth for process and WebSocket |

## Result

- Gateway starts successfully with auto-generated token
- WebSocket connection authenticated properly
- No manual configuration required for first-time users
