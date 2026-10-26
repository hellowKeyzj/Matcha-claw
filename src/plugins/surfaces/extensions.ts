import type { ReactNode, Ref } from 'react';
import { defineExtensionPoint } from '@/plugin-host/core';
import type { SessionIdentity } from '@/types/desktop/runtime-address';
import type { BoardIdentity, BoardWidget } from '@/types/board';
import type { OpenClawCanvasSurfaceDescriptor, OpenClawMcpAppSurfaceDescriptor } from '@/types/openclaw-runtime-surface';
import type { BrowserSurfaceTarget } from './browser-runtime-controller';
import type { ContentCallbacks } from './content-security';
import type { RuntimeContentHandle } from './content-snapshot';

export type RuntimeContentSource =
  | { kind: 'mcp-app'; descriptor: OpenClawMcpAppSurfaceDescriptor }
  | { kind: 'canvas'; descriptor: OpenClawCanvasSurfaceDescriptor }
  | { kind: 'board'; identity: BoardIdentity; widget: BoardWidget };

export type RuntimeSurfaceSource = RuntimeContentSource
  | { kind: 'browser-tab'; surface: BrowserSurfaceTarget; sessionIdentity: SessionIdentity };

export interface RuntimeContentProps extends ContentCallbacks {
  source: RuntimeContentSource;
  onHeightChange?: (height: number) => void;
  onRefresh?: () => void | Promise<void>;
  className?: string;
}

export interface RuntimeSurfaceProps extends Omit<RuntimeContentProps, 'source'> {
  source: RuntimeSurfaceSource;
}

export interface SurfaceRenderer {
  kind: RuntimeSurfaceSource['kind'];
  priority?: number;
  render: (props: RuntimeSurfaceProps & { ref?: Ref<RuntimeContentHandle> }) => ReactNode;
}

export const surfaceRenderers = defineExtensionPoint<SurfaceRenderer>('surfaces.renderers');
