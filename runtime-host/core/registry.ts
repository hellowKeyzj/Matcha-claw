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

export interface RuntimeHostNamedModule {
  readonly name: string;
}

export class RuntimeHostModuleRegistry<Module extends RuntimeHostNamedModule> {
  private readonly registry = new RuntimeHostRegistry<string, Module>();

  constructor(modules: readonly Module[] = []) {
    for (const module of modules) {
      this.register(module);
    }
  }

  register(module: Module): void {
    if (!module.name.trim()) {
      throw new Error('Runtime host module name is required');
    }
    this.registry.register(module.name, module);
  }

  list(): Module[] {
    return this.registry.list().map((entry) => entry.value);
  }

  run(stage: string, execute: (module: Module) => void): void {
    for (const module of this.list()) {
      try {
        execute(module);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        throw new Error(`Runtime host module stage failed: ${module.name}.${stage}: ${message}`);
      }
    }
  }
}
