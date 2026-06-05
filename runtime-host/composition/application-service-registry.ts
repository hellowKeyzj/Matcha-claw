import type { RuntimeHostContainer } from './container';
import type { RuntimeHostModuleResolveEdgeDescriptor } from '../core/registry';
import { runtimeHostTokenKey, type RuntimeHostToken } from './runtime-host-tokens';

interface ApplicationFacadeRegistration {
  readonly owner: string | null;
  readonly resolve: () => unknown;
}

export class ApplicationServiceRegistry {
  private readonly facades = new Map<string, ApplicationFacadeRegistration>();
  private readonly resolveEdges: RuntimeHostModuleResolveEdgeDescriptor[] = [];
  private activeResolutionOwner: string | null = null;

  register<Facade>(owner: string | null, token: RuntimeHostToken<Facade> | string, resolveFacade: () => Facade): void {
    this.registerResolver(owner, token, resolveFacade);
  }

  registerContainerFacade<Facade>(owner: string, token: RuntimeHostToken<Facade> | string, container: RuntimeHostContainer): void {
    const normalizedOwner = this.normalizeOwner(owner);
    this.registerResolver(normalizedOwner, token, () => container.withResolutionOwner(normalizedOwner, () => (
      container.resolve(token)
    )));
  }

  withResolutionOwner<T>(owner: string, resolve: () => T): T {
    const normalizedOwner = owner.trim();
    if (!normalizedOwner) {
      throw new Error('Application service resolution owner is required');
    }
    const previousOwner = this.activeResolutionOwner;
    this.activeResolutionOwner = normalizedOwner;
    try {
      return resolve();
    } finally {
      this.activeResolutionOwner = previousOwner;
    }
  }

  resolve<Facade>(token: RuntimeHostToken<Facade> | string): Facade {
    const normalizedToken = this.normalizeToken(token);
    const registration = this.facades.get(normalizedToken);
    if (!registration) {
      throw new Error(`Application service facade not registered: ${normalizedToken}`);
    }
    this.recordResolveEdge(normalizedToken, registration.owner);
    return registration.resolve() as Facade;
  }

  listTokens(): string[] {
    return Array.from(this.facades.keys());
  }

  listResolveEdges(): RuntimeHostModuleResolveEdgeDescriptor[] {
    return [...this.resolveEdges];
  }

  private registerResolver<Facade>(owner: string | null, token: RuntimeHostToken<Facade> | string, resolveFacade: () => Facade): void {
    const normalizedToken = this.normalizeToken(token);
    if (this.facades.has(normalizedToken)) {
      throw new Error(`Application service facade already registered: ${normalizedToken}`);
    }
    this.facades.set(normalizedToken, {
      owner: owner ? this.normalizeOwner(owner) : null,
      resolve: resolveFacade,
    });
  }

  private normalizeToken(token: string): string {
    try {
      return runtimeHostTokenKey(token);
    } catch {
      throw new Error('Application service facade token is required');
    }
  }

  private normalizeOwner(owner: string): string {
    const normalizedOwner = owner.trim();
    if (!normalizedOwner) {
      throw new Error('Application service facade owner is required');
    }
    return normalizedOwner;
  }

  private recordResolveEdge(token: string, owner: string | null): void {
    if (!this.activeResolutionOwner || this.activeResolutionOwner === owner) {
      return;
    }
    this.resolveEdges.push({
      fromOwner: this.activeResolutionOwner,
      toOwner: owner,
      key: token,
    });
  }
}
