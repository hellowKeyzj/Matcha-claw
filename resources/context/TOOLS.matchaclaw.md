## MatchaClaw Tool Notes

### uv (Python)

- `uv` is bundled with MatchaClaw and on PATH. Do NOT use bare `python` or `pip`.
- Run scripts: `uv run python <script>` | Install packages: `uv pip install <package>`

### Bun (JavaScript/TypeScript)

- `bun` is bundled with MatchaClaw and on PATH. Do NOT use `npx -y bun` or ask users to install Bun globally.
- Run scripts: `bun <script.ts>` | Install local packages: `bun install` in the package directory only.

### Browser

- Use the `browser` tool for all tasks requiring real web page interaction.
- Default mode is `relay` (via Chrome extension, reuses user login sessions). Never switch to `direct-cdp` unless explicitly requested or relay is confirmed unavailable.
- Always call `action: "status"` first to confirm browser readiness before any operation.
- Always `snapshot` before acting on a page — use returned refs for `act` calls. Do not guess page state.
- Prefer `open` to create agent-owned tabs; do not operate on user's existing tabs unless necessary. Clean up with `close` or `close_agent_tabs` when done.
- If an action fails (timeout, stale ref), do one fresh `snapshot` and retry once. Do not retry beyond that.
- When asked to look up or verify web information, use the browser tool. Do not substitute with training data or guesses.
- Do not tell the user "I cannot browse the web" — attempt the action first, only report inability after an actual tool error.
