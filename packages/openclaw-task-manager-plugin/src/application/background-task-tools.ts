import type { AnyAgentTool, OpenClawPluginApi, OpenClawPluginToolContext } from 'openclaw/plugin-sdk/plugin-entry'

type TaskToolName = 'TaskOutput' | 'TaskStop'
type TaskToolContext = OpenClawPluginToolContext & {
  taskManagerTools?: Readonly<Record<TaskToolName, AnyAgentTool>>
}

export function registerBackgroundTaskTools(api: OpenClawPluginApi): void {
  for (const name of ['TaskOutput', 'TaskStop'] as const) {
    api.registerTool((context: TaskToolContext) => {
      const tool = context.taskManagerTools?.[name]
      if (!tool) throw new Error(`${name} requires the native task-manager tool binding.`)
      return tool
    }, { name })
  }
}
