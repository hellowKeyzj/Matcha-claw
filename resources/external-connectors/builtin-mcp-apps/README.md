# Built-in MCP apps

Matcha-owned MCP apps can be bundled here. Each app directory should contain its own runtime entrypoint. The current discovery layer recognizes app directories with `cli.cjs` and exposes them as MCP HTTP-capable server programs for External Connectors.

Example layout:

```text
resources/external-connectors/builtin-mcp-apps/<app-id>/cli.cjs
resources/external-connectors/builtin-mcp-apps/<app-id>/webview/app.html
```
