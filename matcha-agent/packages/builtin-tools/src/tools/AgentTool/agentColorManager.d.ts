import type { Theme } from 'src/utils/theme.js'
export type AgentColorName =
  | 'red'
  | 'blue'
  | 'green'
  | 'yellow'
  | 'purple'
  | 'orange'
  | 'pink'
  | 'cyan'
export declare const AGENT_COLORS: readonly AgentColorName[]
export declare const AGENT_COLOR_TO_THEME_COLOR: {
  readonly red: 'red_FOR_SUBAGENTS_ONLY'
  readonly blue: 'blue_FOR_SUBAGENTS_ONLY'
  readonly green: 'green_FOR_SUBAGENTS_ONLY'
  readonly yellow: 'yellow_FOR_SUBAGENTS_ONLY'
  readonly purple: 'purple_FOR_SUBAGENTS_ONLY'
  readonly orange: 'orange_FOR_SUBAGENTS_ONLY'
  readonly pink: 'pink_FOR_SUBAGENTS_ONLY'
  readonly cyan: 'cyan_FOR_SUBAGENTS_ONLY'
}
export declare function getAgentColor(
  agentType: string,
): keyof Theme | undefined
export declare function setAgentColor(
  agentType: string,
  color: AgentColorName | undefined,
): void
