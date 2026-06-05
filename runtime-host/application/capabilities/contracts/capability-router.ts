import { buildRuntimeAddressKey, validateRuntimeAddress, type RuntimeAddress } from '../../agent-runtime/contracts/runtime-address';
import { badRequest, type ApplicationResponse } from '../../common/application-response';
import type { CapabilityDescriptor } from './capability-descriptor';

export interface CapabilityExecuteRequest {
  id: string;
  operationId: string;
  address: RuntimeAddress;
  input: unknown;
}

export interface CapabilityOperationContext {
  capabilityId: string;
  operationId: string;
  address: RuntimeAddress;
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
  getCapability: (descriptor: Pick<CapabilityDescriptor, 'id' | 'address'>) => CapabilityDescriptor;
  operations: readonly CapabilityOperationRoute[] | (() => readonly CapabilityOperationRoute[]);
}

export class CapabilityRouter {
  private readonly operations: Map<string, CapabilityOperationHandler> | null;
  private readonly descriptorOperationIndexes = new WeakMap<CapabilityDescriptor, Set<string>>();

  constructor(private readonly deps: CapabilityRouterDeps) {
    this.operations = Array.isArray(deps.operations)
      ? this.buildOperationMap(deps.operations)
      : null;
  }

  async execute(request: CapabilityExecuteRequest): Promise<ApplicationResponse> {
    const requestAddressError = this.validateRequestAddress(request);
    if (requestAddressError) {
      return badRequest(requestAddressError);
    }

    const descriptor = this.deps.getCapability({ id: request.id, address: request.address });
    const addressError = this.validateDescriptorAddress(request, descriptor);
    if (addressError) {
      return badRequest(addressError);
    }
    if (!this.descriptorSupportsOperation(descriptor, request.operationId)) {
      return badRequest(`Capability operation not supported: ${request.operationId}`);
    }

    const inputAddressError = this.validateInputAddress(request);
    if (inputAddressError) {
      return badRequest(inputAddressError);
    }

    const handler = this.resolveOperations().get(this.buildOperationKey(descriptor.id, request.operationId));
    if (!handler) {
      return badRequest(`Capability execution not supported: ${descriptor.id}`);
    }

    return await handler(this.buildOperationPayload(request));
  }

  private validateRequestAddress(request: CapabilityExecuteRequest): string | null {
    if (request.address.capabilityId !== request.id) {
      return 'Capability id does not match RuntimeAddress capabilityId';
    }
    return validateRuntimeAddress(request.address);
  }

  private validateDescriptorAddress(request: CapabilityExecuteRequest, descriptor: CapabilityDescriptor): string | null {
    if (descriptor.id !== request.id) {
      return 'Capability descriptor id does not match request id';
    }
    return buildRuntimeAddressKey(descriptor.address) === buildRuntimeAddressKey(request.address)
      ? null
      : 'Capability descriptor RuntimeAddress does not match request RuntimeAddress';
  }

  private descriptorSupportsOperation(descriptor: CapabilityDescriptor, operationId: string): boolean {
    let operationIndex = this.descriptorOperationIndexes.get(descriptor);
    if (!operationIndex) {
      operationIndex = new Set(descriptor.operations.map((operation) => operation.id));
      this.descriptorOperationIndexes.set(descriptor, operationIndex);
    }
    return operationIndex.has(operationId);
  }

  private validateInputAddress(request: CapabilityExecuteRequest): string | null {
    const input = request.input && typeof request.input === 'object' && !Array.isArray(request.input)
      ? request.input as Record<string, unknown>
      : {};
    const inputAddress = input.runtimeAddress;
    if (inputAddress === undefined) {
      return 'Capability input RuntimeAddress is required';
    }
    const inputAddressError = validateRuntimeAddress(inputAddress);
    if (inputAddressError) {
      return inputAddressError;
    }
    return buildRuntimeAddressKey(inputAddress as RuntimeAddress) === buildRuntimeAddressKey(request.address)
      ? null
      : 'Capability input RuntimeAddress does not match request RuntimeAddress';
  }

  private buildOperationPayload(request: CapabilityExecuteRequest): CapabilityOperationContext {
    const input = request.input && typeof request.input === 'object' && !Array.isArray(request.input)
      ? request.input as Record<string, unknown>
      : {};
    const { runtimeAddress: _runtimeAddress, ...domainInput } = input;
    return {
      capabilityId: request.id,
      operationId: request.operationId,
      address: request.address,
      input: request.input,
      domainInput,
    };
  }

  private resolveOperations(): Map<string, CapabilityOperationHandler> {
    return this.operations ?? this.buildOperationMap(this.deps.operations());
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
