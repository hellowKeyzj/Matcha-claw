export declare const DISCOVER_SKILLS_TOOL_NAME = 'DiscoverSkills'
export declare const DESCRIPTION =
  'Search for relevant skills by describing what you want to do'
export declare const DISCOVER_SKILLS_PROMPT =
  "Search for skills relevant to a task description. Returns matching skills ranked by relevance.\n\nUse this when:\n- The auto-surfaced skills don't cover your current task\n- You're pivoting to a different kind of work mid-conversation\n- You want to find specialized skills for an unusual workflow\n\nThe search uses TF-IDF keyword matching against all registered skills (bundled, user-defined, and MCP-provided). Results include skill name, description, and relevance score."
