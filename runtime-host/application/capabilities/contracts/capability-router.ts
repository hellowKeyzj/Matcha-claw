import {
  buildCapabilityScopeKey,
  targetBelongsToScope,
  validateCapabilityTarget,
  validateRuntimeScope,
  type CapabilityTarget,
  type RuntimeScope,
} from '../../agent-runtime/contracts/runtime-address';
import { badRequest, type ApplicationResponse } from '../../common/application-response';
import type { CapabilityDescriptor, CapabilityOperationDescriptor } from './capability-descriptor';

export interface CapabilityExecuteRequest {
  id: string;
  operationId: string;
  scope: RuntimeScope;
  target?: CapabilityTarget | null;
  input: unknown;
}

export interface CapabilityOperationContext {
  capabilityId: string;
  operationId: string;
  scope: RuntimeScope;
  target: CapabilityTarget | null;
  input: unknown;
  domainInput: Record<string, unknown>;
}

type CapabilityOperationHandler = (context: CapabilityOperationContext) => Promise<ApplicationResponse> | ApplicationResponse;

export interface CapabilityOperationRoute {
  capabilityId: string;
  operationId: string;
  handle: CapabilityOperationHandler;
}

export interface CapabilityRouterDeps {
  getCapability: (descriptor: Pick<CapabilityDescriptor, 'id' | 'scope'>) => CapabilityDescriptor;
  operations: readonly CapabilityOperationRoute[] | (() => readonly CapabilityOperationRoute[]);
}

export class CapabilityRouter {
  private operationMap: Map<string, CapabilityOperationHandler> | null;
  private readonly descriptorOperationIndexes = new WeakMap<CapabilityDescriptor, Map<string, CapabilityOperationDescriptor>>();

  constructor(private readonly deps: CapabilityRouterDeps) {
    this.operationMap = typeof deps.operations === 'function'
      ? null
      : this.buildOperationMap(deps.operations);
  }

  async execute(request: CapabilityExecuteRequest): Promise<ApplicationResponse> {
    const requestError = this.validateRequest(request);
    if (requestError) {
      return badRequest(requestError);
    }

    const descriptor = this.deps.getCapability({ id: request.id, scope: request.scope });
    const descriptorError = this.validateDescriptor(request, descriptor);
    if (descriptorError) {
      return badRequest(descriptorError);
    }

    const operation = this.resolveDescriptorOperation(descriptor, request.operationId);
    if (!operation) {
      return badRequest(`Capability operation not supported: ${request.operationId}`);
    }

    const targetError = this.validateTarget(request, operation);
    if (targetError) {
      return badRequest(targetError);
    }

    const inputError = this.validateInput(request.input);
    if (inputError) {
      return badRequest(inputError);
    }

    const handler = this.resolveOperations().get(this.buildOperationKey(descriptor.id, request.operationId));
    if (!handler) {
      return badRequest(`Capability execution not supported: ${descriptor.id}`);
    }

    return await handler(this.buildOperationPayload(request));
  }

  private validateRequest(request: CapabilityExecuteRequest): string | null {
    if (typeof request.id !== 'string' || !request.id.trim()) {
      return 'Capability id is required';
    }
    if (typeof request.operationId !== 'string' || !request.operationId.trim()) {
      return 'Capability operationId is required';
    }
    return validateRuntimeScope(request.scope);
  }

  private validateDescriptor(request: CapabilityExecuteRequest, descriptor: CapabilityDescriptor): string | null {
    if (descriptor.id !== request.id) {
      return 'Capability descriptor id does not match request id';
    }
    if (buildCapabilityScopeKey(descriptor.scope) !== buildCapabilityScopeKey(request.scope)) {
      return 'Capability descriptor scope does not match request scope';
    }
    return null;
  }

  private resolveDescriptorOperation(descriptor: CapabilityDescriptor, operationId: string): CapabilityOperationDescriptor | null {
    let operationIndex = this.descriptorOperationIndexes.get(descriptor);
    if (!operationIndex) {
      operationIndex = new Map(descriptor.operations.map((operation) => [operation.id, operation]));
      this.descriptorOperationIndexes.set(descriptor, operationIndex);
    }
    return operationIndex.get(operationId) ?? null;
  }

  private validateTarget(request: CapabilityExecuteRequest, operation: CapabilityOperationDescriptor): string | null {
    const target = request.target ?? null;
    if (operation.targetRequired && (!target || target.kind === 'none')) {
      return `Capability operation target is required: ${operation.id}`;
    }
    if (!target) {
      return operation.targetKind === 'none' ? null : `Capability operation target is required: ${operation.id}`;
    }
    const targetError = validateCapabilityTarget(target);
    if (targetError) {
      return targetError;
    }
    if (target.kind !== operation.targetKind) {
      return `Capability operation target kind must be ${operation.targetKind}`;
    }
    if (!targetBelongsToScope(target, request.scope)) {
      return 'Capability target does not belong to request scope';
    }
    return null;
  }

  private validateInput(input: unknown): string | null {
    if (!input || typeof input !== 'object' || Array.isArray(input)) {
      return null;
    }
    return (input as Record<string, unknown>).runtimeAddress === undefined
      ? null
      : 'Capability input runtimeAddress is not allowed';
  }

  private buildOperationPayload(request: CapabilityExecuteRequest): CapabilityOperationContext {
    const domainInput = request.input && typeof request.input === 'object' && !Array.isArray(request.input)
      ? request.input as Record<string, unknown>
      : {};
    return {
      capabilityId: request.id,
      operationId: request.operationId,
      scope: request.scope,
      target: request.target ?? null,
      input: request.input,
      domainInput,
    };
  }

  private resolveOperations(): Map<string, CapabilityOperationHandler> {
    if (!this.operationMap) {
      const operations = this.deps.operations;
      this.operationMap = this.buildOperationMap(typeof operations === 'function' ? operations() : operations);
    }
    return this.operationMap;
  }

  private buildOperationMap(routes: readonly CapabilityOperationRoute[]): Map<string, CapabilityOperationHandler> {
    const operations = new Map<string, CapabilityOperationHandler>();
    for (const operation of routes) {
      const operationKey = this.buildOperationKey(operation.capabilityId, operation.operationId);
      if (operations.has(operationKey)) {
        throw new Error(`Capability operation route already registered: ${operationKey}`);
      }
      operations.set(operationKey, operation.handle);
    }
    return operations;
  }

  private buildOperationKey(capabilityId: string, operationId: string): string {
    return `${capabilityId}:${operationId}`;
  }
}
