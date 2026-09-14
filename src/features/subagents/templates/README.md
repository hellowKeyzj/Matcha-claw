# OpenClaw Integration

OpenClaw agents are installed as workspaces containing `AGENTS.md`, `SOUL.md`, `USER.md`, and `MEMORY.md` files. Local tool notes belong in the `## Tools` section of `AGENTS.md`; standalone `TOOLS.md` files are not generated.

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
