export type RuntimeHostFactory<T> = (container: RuntimeHostContainer) => T;

export class RuntimeHostContainer {
  private readonly factories = new Map<string, RuntimeHostFactory<unknown>>();
  private readonly instances = new Map<string, unknown>();

  register<T>(key: string, factory: RuntimeHostFactory<T>): void {
    if (this.factories.has(key) || this.instances.has(key)) {
      throw new Error(`Runtime host dependency already registered: ${key}`);
    }
    this.factories.set(key, factory as RuntimeHostFactory<unknown>);
  }

  registerValue<T>(key: string, value: T): void {
    if (this.factories.has(key) || this.instances.has(key)) {
      throw new Error(`Runtime host dependency already registered: ${key}`);
    }
    this.instances.set(key, value);
  }

  resolve<T>(key: string): T {
    if (this.instances.has(key)) {
      return this.instances.get(key) as T;
    }
    const factory = this.factories.get(key);
    if (!factory) {
      throw new Error(`Runtime host dependency not registered: ${key}`);
    }
    const instance = factory(this);
    this.instances.set(key, instance);
    return instance as T;
  }
}
