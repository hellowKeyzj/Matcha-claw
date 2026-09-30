export type PlatformOperation =
  | 'openclaw.environment.status'
  | 'openclaw.runtime.paths'
  | 'openclaw.cli.command'
  | 'openclaw.tool-permission.get'
  | 'openclaw.tool-permission.set'
  | 'openclaw.subagent-templates.list'
  | 'openclaw.subagent-templates.get';

export interface PlatformCallDetail {
  runtime: 'openclaw';
  operation: PlatformOperation;
}

declare module '../call-log' {
  interface CallDetailByModule {
    'openclaw-platform': PlatformCallDetail;
  }
}

export function decodePlatformCallDetail(value: unknown): PlatformCallDetail | undefined {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const detail = value as Record<string, unknown>;
  if (Object.keys(detail).length !== 2 || detail.runtime !== 'openclaw'
    || (detail.operation !== 'openclaw.environment.status'
      && detail.operation !== 'openclaw.runtime.paths'
      && detail.operation !== 'openclaw.cli.command'
      && detail.operation !== 'openclaw.tool-permission.get'
      && detail.operation !== 'openclaw.tool-permission.set'
      && detail.operation !== 'openclaw.subagent-templates.list'
      && detail.operation !== 'openclaw.subagent-templates.get')) return undefined;
  return { runtime: detail.runtime, operation: detail.operation };
}
