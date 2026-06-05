export interface RuntimeHostRegistryEntry<Key extends string, Value> {
  readonly key: Key;
  readonly value: Value;
}

export class RuntimeHostRegistry<Key extends string, Value> {
  private readonly entries = new Map<Key, Value>();

  register(key: Key, value: Value): void {
    if (this.entries.has(key)) {
      throw new Error(`Runtime host registry entry already registered: ${key}`);
    }
    this.entries.set(key, value);
  }

  list(): Array<RuntimeHostRegistryEntry<Key, Value>> {
    return Array.from(this.entries.entries()).map(([key, value]) => ({
      key,
      value,
    }));
  }
}

export interface RuntimeHostModuleManifest {
  readonly id: string;
  readonly imports?: readonly string[];
  readonly exports?: readonly string[];
  readonly registerProviders?: boolean;
  readonly registerRoutes?: boolean;
  readonly registerJobs?: boolean;
  readonly registerLifecycle?: boolean;
  readonly connect?: boolean;
  readonly connectImports?: readonly string[];
}

export interface RuntimeHostNamedModule {
  readonly name: string;
  readonly manifest: RuntimeHostModuleManifest;
}

export interface RuntimeHostModuleTokenDescriptor {
  readonly moduleName: string;
  readonly token: string;
}

export interface RuntimeHostRegistrationOwnerDescriptor {
  readonly key: string;
  readonly owner: string | null;
}

export interface RuntimeHostModuleRegistrationDiagnostic {
  readonly key: string;
  readonly owner: string;
  readonly exported: boolean;
}

export interface RuntimeHostModuleResolveEdgeDescriptor {
  readonly fromOwner: string;
  readonly toOwner: string | null;
  readonly key: string;
}

export interface RuntimeHostModuleStageDescriptor<Module extends RuntimeHostNamedModule> {
  readonly name: string;
  readonly handler: keyof Module;
}

interface RuntimeHostModuleRegistryOptions<Module extends RuntimeHostNamedModule> {
  readonly externalExports?: readonly string[];
  readonly stages?: readonly RuntimeHostModuleStageDescriptor<Module>[];
}

export class RuntimeHostModuleRegistry<Module extends RuntimeHostNamedModule> {
  private readonly registry = new RuntimeHostRegistry<string, Module>();
  private readonly externalExports: readonly string[];
  private readonly stageHandlers: readonly RuntimeHostModuleStageDescriptor<Module>[];

  constructor(modules: readonly Module[] = [], options: RuntimeHostModuleRegistryOptions<Module> = {}) {
    this.externalExports = options.externalExports ?? [];
    this.stageHandlers = options.stages ?? [];

    for (const module of modules) {
      this.registerModule(module);
    }
    this.validateManifests();
  }

  register(module: Module): void {
    this.registerModule(module);
    this.validateManifests();
  }

  private registerModule(module: Module): void {
    if (!module.name.trim()) {
      throw new Error('Runtime host module name is required');
    }
    if (module.manifest && module.manifest.id !== module.name) {
      throw new Error(`Runtime host module manifest id mismatch: ${module.name} != ${module.manifest.id}`);
    }
    this.registry.register(module.name, module);
  }

  list(): Module[] {
    return this.registry.list().map((entry) => entry.value);
  }

  listModuleNames(): string[] {
    return this.list().map((module) => module.name);
  }

  listExports(): RuntimeHostModuleTokenDescriptor[] {
    return this.list().flatMap((module) => (module.manifest?.exports ?? []).map((token) => ({
      moduleName: module.name,
      token,
    })));
  }

  listImports(): RuntimeHostModuleTokenDescriptor[] {
    return this.list().flatMap((module) => (module.manifest?.imports ?? []).map((token) => ({
      moduleName: module.name,
      token,
    })));
  }

  listRegistrationDiagnostics(
    registrations: readonly RuntimeHostRegistrationOwnerDescriptor[],
  ): RuntimeHostModuleRegistrationDiagnostic[] {
    const moduleNames = new Set(this.listModuleNames());
    const exportedByOwner = new Map<string, Set<string>>();
    for (const item of this.listExports()) {
      const ownerExports = exportedByOwner.get(item.moduleName) ?? new Set<string>();
      ownerExports.add(item.token);
      exportedByOwner.set(item.moduleName, ownerExports);
    }

    return registrations
      .filter((registration) => registration.owner !== null && moduleNames.has(registration.owner))
      .map((registration) => ({
        key: registration.key,
        owner: registration.owner as string,
        exported: exportedByOwner.get(registration.owner as string)?.has(registration.key) ?? false,
      }));
  }

  validateRegistrationOwners(registrations: readonly RuntimeHostRegistrationOwnerDescriptor[]): void {
    const moduleNames = new Set(this.listModuleNames());
    const exportedBy = new Map<string, string>();
    for (const item of this.listExports()) {
      exportedBy.set(item.token, item.moduleName);
    }

    for (const registration of registrations) {
      if (!registration.owner || !moduleNames.has(registration.owner)) {
        continue;
      }
      const exportedOwner = exportedBy.get(registration.key);
      const registrationKind = (registration as { readonly kind?: string }).kind;
      if (exportedOwner && registrationKind !== 'contribution' && registration.owner !== exportedOwner) {
        throw new Error(`Runtime host module export owner mismatch: ${registration.key} exported by ${exportedOwner} but registered by ${registration.owner ?? 'external'}`);
      }
    }
  }

  validateResolveImports(edges: readonly RuntimeHostModuleResolveEdgeDescriptor[]): void {
    const moduleNames = new Set(this.listModuleNames());
    const externalExports = new Set(this.externalExports);
    const exportedByOwner = new Map<string, Set<string>>();
    for (const item of this.listExports()) {
      const ownerExports = exportedByOwner.get(item.moduleName) ?? new Set<string>();
      ownerExports.add(item.token);
      exportedByOwner.set(item.moduleName, ownerExports);
    }
    const importsByModule = new Map<string, Set<string>>();
    for (const item of this.listImports()) {
      const imports = importsByModule.get(item.moduleName) ?? new Set<string>();
      imports.add(item.token);
      importsByModule.set(item.moduleName, imports);
    }

    for (const edge of edges) {
      if (!moduleNames.has(edge.fromOwner) || edge.toOwner === edge.fromOwner) {
        continue;
      }
      if (edge.toOwner && moduleNames.has(edge.toOwner) && !exportedByOwner.get(edge.toOwner)?.has(edge.key)) {
        throw new Error(`Runtime host module dependency not exported: ${edge.fromOwner} resolves ${edge.key} owned by ${edge.toOwner}`);
      }
      if (!edge.toOwner && !externalExports.has(edge.key)) {
        continue;
      }
      if (!importsByModule.get(edge.fromOwner)?.has(edge.key)) {
        throw new Error(`Runtime host module import not declared: ${edge.fromOwner} resolves ${edge.key}`);
      }
    }
  }

  private readDeclaredStages(module: Module): Set<string> {
    const stages: string[] = [];
    const manifest = module.manifest;
    if (manifest.registerProviders) {
      const providerStages = this.stageHandlers.filter((descriptor) => (
        descriptor.name === 'providers'
        || descriptor.name === 'services'
        || descriptor.name === 'infrastructure'
      ));
      const implementedProviderStages = providerStages.filter((descriptor) => typeof module[descriptor.handler] === 'function');
      stages.push(...(implementedProviderStages.length > 0 ? implementedProviderStages : providerStages).map((descriptor) => descriptor.name));
    }
    if (manifest.registerRoutes) {
      stages.push('routes');
    }
    if (manifest.registerJobs) {
      stages.push('jobs');
    }
    if (manifest.registerLifecycle) {
      stages.push('lifecycle');
    }
    if (manifest.connect) {
      stages.push('connect');
    }
    return new Set(stages);
  }

  private validateManifests(): void {
    const exportedBy = new Map<string, string>();
    const imports: Array<{ moduleName: string; token: string }> = [];

    for (const token of this.externalExports) {
      const owner = exportedBy.get(token);
      if (owner) {
        throw new Error(`Runtime host module export already registered: ${token} by ${owner} and external`);
      }
      exportedBy.set(token, 'external');
    }

    for (const module of this.list()) {
      const manifest = module.manifest;
      if (!manifest) {
        throw new Error(`Runtime host module manifest is required: ${module.name}`);
      }
      const declaredStages = this.readDeclaredStages(module);
      for (const descriptor of this.stageHandlers) {
        const hasHandler = typeof module[descriptor.handler] === 'function';
        if (declaredStages.has(descriptor.name) && !hasHandler) {
          throw new Error(`Runtime host module stage handler missing: ${module.name}.${descriptor.name}`);
        }
        if (!declaredStages.has(descriptor.name) && hasHandler) {
          throw new Error(`Runtime host module stage not declared: ${module.name}.${descriptor.name}`);
        }
      }
      for (const token of manifest.exports ?? []) {
        const owner = exportedBy.get(token);
        if (owner) {
          throw new Error(`Runtime host module export already registered: ${token} by ${owner} and ${module.name}`);
        }
        exportedBy.set(token, module.name);
      }
      for (const token of manifest.imports ?? []) {
        imports.push({ moduleName: module.name, token });
      }
    }

    const dependenciesByModule = new Map<string, Set<string>>();
    const moduleNames = new Set(this.listModuleNames());
    const connectDependenciesByModule = new Map<string, Set<string>>();
    for (const module of this.list()) {
      for (const dependency of module.manifest.connectImports ?? []) {
        if (!moduleNames.has(dependency)) {
          throw new Error(`Runtime host module connect import not registered: ${module.name} imports ${dependency}`);
        }
        if (dependency !== module.name) {
          const dependencies = connectDependenciesByModule.get(module.name) ?? new Set<string>();
          dependencies.add(dependency);
          connectDependenciesByModule.set(module.name, dependencies);
        }
      }
    }
    for (const item of imports) {
      const owner = exportedBy.get(item.token);
      if (!owner) {
        throw new Error(`Runtime host module import not exported: ${item.moduleName} imports ${item.token}`);
      }
      if (owner !== 'external' && owner !== item.moduleName) {
        const dependencies = dependenciesByModule.get(item.moduleName) ?? new Set<string>();
        dependencies.add(owner);
        dependenciesByModule.set(item.moduleName, dependencies);
      }
    }
    this.validateAcyclicModuleImports(dependenciesByModule, 'import');
    this.validateAcyclicModuleImports(connectDependenciesByModule, 'connect');
  }

  private validateAcyclicModuleImports(dependenciesByModule: Map<string, Set<string>>, graphKind: 'import' | 'connect'): void {
    const visiting: string[] = [];
    const visited = new Set<string>();
    const active = new Set<string>();
    const visit = (moduleName: string): void => {
      if (visited.has(moduleName)) {
        return;
      }
      if (active.has(moduleName)) {
        const cycleStart = visiting.indexOf(moduleName);
        const cycle = [...visiting.slice(cycleStart), moduleName];
        throw new Error(`Runtime host module ${graphKind} cycle: ${cycle.join(' -> ')}`);
      }
      active.add(moduleName);
      visiting.push(moduleName);
      for (const dependency of dependenciesByModule.get(moduleName) ?? []) {
        visit(dependency);
      }
      visiting.pop();
      active.delete(moduleName);
      visited.add(moduleName);
    };
    for (const moduleName of dependenciesByModule.keys()) {
      visit(moduleName);
    }
  }

  run(stage: string, execute: (module: Module) => void): void {
    for (const module of this.list()) {
      if (!this.readDeclaredStages(module).has(stage)) {
        continue;
      }
      try {
        execute(module);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        throw new Error(`Runtime host module stage failed: ${module.name}.${stage}: ${message}`);
      }
    }
  }
}
