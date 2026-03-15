# OpenClaw Integration

OpenClaw agents are installed as workspaces containing `AGENTS.md`, `SOUL.md`,
`TOOLS.md`, `IDENTITY.md`, and `USER.md` files. The installer copies each workspace into
`~/.openclaw/agency-agents/` and registers it when the `openclaw` CLI is
available.

Before installing, generate the OpenClaw workspaces:

```bash
./scripts/convert.sh --tool openclaw
```

## Install

```bash
./scripts/install.sh --tool openclaw
```

## Activate an Agent

After installation, agents are available by `agentId` in OpenClaw sessions.

If the OpenClaw gateway is already running, restart it after installation:

```bash
openclaw gateway restart
```

## Regenerate

```bash
./scripts/convert.sh --tool openclaw
```
