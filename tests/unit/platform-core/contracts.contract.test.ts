import { describe, expectTypeOf, it } from 'vitest';
import type {
  AgentRuntimeDriver,
  ContextAssemblerPort,
  EventBusPort,
  ReconcilerPort,
  RuntimeManagerPort,
  RunContext,
  ToolExecutorPort,
  ToolRegistryPort,
} from '@electron/core/contracts';

describe('platform contracts', () => {
  it('defines runtime execute signature', () => {
    expectTypeOf<AgentRuntimeDriver['execute']>().parameters.toMatchTypeOf<[RunContext, unknown?]>();
  });

  it('defines core platform ports', () => {
    expectTypeOf<ToolRegistryPort>().toBeObject();
    expectTypeOf<ContextAssemblerPort>().toBeObject();
    expectTypeOf<ToolExecutorPort>().toBeObject();
    expectTypeOf<RuntimeManagerPort>().toBeObject();
    expectTypeOf<EventBusPort>().toBeObject();
    expectTypeOf<ReconcilerPort>().toBeObject();
  });
});
