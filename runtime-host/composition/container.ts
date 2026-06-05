import { runtimeHostTokenKey, type RuntimeHostToken } from './runtime-host-tokens';

export type RuntimeHostFactory<T> = (container: RuntimeHostContainer) => T;

export interface RuntimeHostRegistrationMetadata {
  readonly owner: string | null;
}

export interface RuntimeHostRegistrationDescriptor extends RuntimeHostRegistrationMetadata {
  readonly key: string;
  readonly kind: 'factory' | 'value' | 'contribution';
  readonly resolved: boolean;
}

export interface RuntimeHostResolveEdgeDescriptor {
  readonly fromOwner: string;
  readonly toOwner: string | null;
  readonly key: string;
}

export class RuntimeHostContainer {
  private readonly factories = new Map<string, RuntimeHostFactory<unknown>>();
  private readonly instances = new Map<string, unknown>();
  private readonly registrations = new Map<string, RuntimeHostRegistrationMetadata>();
  private readonly contributionRegistrations = new Map<string, RuntimeHostRegistrationMetadata[]>();
  private readonly contributions = new Map<string, Array<RuntimeHostFactory<unknown>>>();
  private readonly resolveEdges: RuntimeHostResolveEdgeDescriptor[] = [];
  private activeRegistrationOwner: string | null = null;
  private activeResolutionOwner: string | null = null;

  register<T>(token: RuntimeHostToken<T> | string, factory: RuntimeHostFactory<T>): void {
    const key = runtimeHostTokenKey(token);
    this.ensureCanRegister(key);
    this.factories.set(key, factory as RuntimeHostFactory<unknown>);
    this.registrations.set(key, {
      owner: this.activeRegistrationOwner,
    });
  }

  registerValue<T>(token: RuntimeHostToken<T> | string, value: T): void {
    const key = runtimeHostTokenKey(token);
    this.ensureCanRegister(key);
    this.instances.set(key, value);
    this.registrations.set(key, {
      owner: this.activeRegistrationOwner,
    });
  }

  contribute<T>(token: RuntimeHostToken<T> | string, factory: RuntimeHostFactory<T>): void {
    const key = runtimeHostTokenKey(token);
    if (this.factories.has(key) || this.instances.has(key)) {
      throw new Error(`Runtime host dependency already registered as singular token: ${key}`);
    }
    this.contributions.set(key, [...(this.contributions.get(key) ?? []), factory as RuntimeHostFactory<unknown>]);
    this.contributionRegistrations.set(key, [
      ...(this.contributionRegistrations.get(key) ?? []),
      { owner: this.activeRegistrationOwner },
    ]);
  }

  withRegistrationOwner<T>(owner: string, register: () => T): T {
    const normalizedOwner = owner.trim();
    if (!normalizedOwner) {
      throw new Error('Runtime host registration owner is required');
    }
    const previousOwner = this.activeRegistrationOwner;
    this.activeRegistrationOwner = normalizedOwner;
    try {
      return register();
    } finally {
      this.activeRegistrationOwner = previousOwner;
    }
  }

  withResolutionOwner<T>(owner: string, resolve: () => T): T {
    const normalizedOwner = owner.trim();
    if (!normalizedOwner) {
      throw new Error('Runtime host resolution owner is required');
    }
    const previousOwner = this.activeResolutionOwner;
    this.activeResolutionOwner = normalizedOwner;
    try {
      return resolve();
    } finally {
      this.activeResolutionOwner = previousOwner;
    }
  }

  listRegistrations(): RuntimeHostRegistrationDescriptor[] {
    return [
      ...Array.from(this.registrations.entries()).map(([key, metadata]) => ({
        key,
        owner: metadata.owner,
        kind: this.factories.has(key) ? 'factory' as const : 'value' as const,
        resolved: this.instances.has(key),
      })),
      ...Array.from(this.contributionRegistrations.entries()).flatMap(([key, registrations]) => registrations.map((metadata) => ({
        key,
        owner: metadata.owner,
        kind: 'contribution' as const,
        resolved: false,
      }))),
    ];
  }

  listResolveEdges(): RuntimeHostResolveEdgeDescriptor[] {
    return [...this.resolveEdges];
  }

  resolve<T>(token: RuntimeHostToken<T> | string): T {
    const key = runtimeHostTokenKey(token);
    this.recordResolveEdge(key);
    if (this.instances.has(key)) {
      return this.instances.get(key) as T;
    }
    const factory = this.factories.get(key);
    if (!factory) {
      throw new Error(`Runtime host dependency not registered: ${key}`);
    }
    const registration = this.registrations.get(key) ?? null;
    const previousResolutionOwner = this.activeResolutionOwner;
    this.activeResolutionOwner = registration?.owner ?? previousResolutionOwner;
    try {
      const instance = factory(this);
      this.instances.set(key, instance);
      return instance as T;
    } finally {
      this.activeResolutionOwner = previousResolutionOwner;
    }
  }

  resolveContributions<T>(token: RuntimeHostToken<T> | string): T[] {
    const key = runtimeHostTokenKey(token);
    this.recordResolveEdge(key);
    const factories = this.contributions.get(key) ?? [];
    const registrations = this.contributionRegistrations.get(key) ?? [];
    return factories.map((factory, index) => {
      const owner = registrations[index]?.owner ?? null;
      const previousResolutionOwner = this.activeResolutionOwner;
      this.activeResolutionOwner = owner ?? previousResolutionOwner;
      try {
        return factory(this) as T;
      } finally {
        this.activeResolutionOwner = previousResolutionOwner;
      }
    });
  }

  private recordResolveEdge(key: string): void {
    if (!this.activeResolutionOwner) {
      return;
    }
    const targetOwner = this.registrations.get(key)?.owner
      ?? this.resolveContributionOwner(key)
      ?? null;
    if (targetOwner === this.activeResolutionOwner) {
      return;
    }
    this.resolveEdges.push({
      fromOwner: this.activeResolutionOwner,
      toOwner: targetOwner,
      key,
    });
  }

  private resolveContributionOwner(key: string): string | null {
    const owners = new Set(
      (this.contributionRegistrations.get(key) ?? [])
        .map((registration) => registration.owner)
        .filter((owner): owner is string => Boolean(owner)),
    );
    return owners.size === 1 ? [...owners][0] ?? null : null;
  }

  private ensureCanRegister(key: string): void {
    if (this.factories.has(key) || this.instances.has(key) || this.contributions.has(key)) {
      throw new Error(`Runtime host dependency already registered: ${key}`);
    }
  }
}
