# Built-in MCP plugin programs

Matcha-owned MCP plugin programs can be bundled here. Each plugin directory may include a `.mcp.json` file with `mcpServers` entries. At runtime, Matcha discovers these manifests and exposes them as selectable MCP server programs for External Connectors.

Example layout:

```text
resources/external-connectors/builtin-plugins/<plugin-id>/.mcp.json
resources/external-connectors/builtin-plugins/<plugin-id>/dist/server.mjs
```

Use `${MATCHA_EXTERNAL_CONNECTOR_PROGRAM_ROOT}` in `.mcp.json` command or args values to refer to the plugin directory.
