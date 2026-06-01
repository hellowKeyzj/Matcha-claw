export declare const LIST_MCP_RESOURCES_TOOL_NAME = 'ListMcpResourcesTool'
export declare const DESCRIPTION =
  "\nLists available resources from configured MCP servers.\nEach resource object includes a 'server' field indicating which server it's from.\n\nUsage examples:\n- List all resources from all servers: `listMcpResources`\n- List resources from a specific server: `listMcpResources({ server: \"myserver\" })`\n"
export declare const PROMPT =
  "\nList available resources from configured MCP servers.\nEach returned resource will include all standard MCP resource fields plus a 'server' field \nindicating which server the resource belongs to.\n\nParameters:\n- server (optional): The name of a specific MCP server to get resources from. If not provided,\n  resources from all servers will be returned.\n"
