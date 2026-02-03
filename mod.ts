// deno-lint-ignore-file no-explicit-any

export interface Disposable {
  dispose(): void | Promise<void>;
}

export interface Container<Entries extends Record<string, unknown> = any> {
  // Registration
  register<T>(name: string, instance: T): void;
  registerFactory<T, E extends Entries = Entries>(
    name: string,
    factory: (container: Container<E>) => T | Promise<T>,
  ): void;
  registerSingleton<T, E extends Entries = Entries>(
    name: string,
    factory: (container: Container<E>) => T | Promise<T>,
  ): void;

  // Resolution
  resolve<T, K extends keyof Entries = keyof Entries>(
    name: K,
  ): T extends object ? T : Entries[K];

  resolveAsync<T, K extends keyof Entries = keyof Entries>(
    name: K,
  ): Promise<T extends object ? T : Entries[K]>;

  has<K extends keyof Entries = keyof Entries>(name: K): boolean;

  // Scoping
  createChild<ChildEntries extends Record<string, unknown> = Record<string, unknown>>(): Container<ChildEntries>;

  /**
   * Get the parent container, if any.
   */
  getParent(): Container<Entries> | null;

  /**
   * Used when you want to resolve from the parent container if the service is not found in the current container.
   * This is useful when you want to resolve a service from a parent container in a possible child container.
   */
  getParentOrCurrent(): Container<Entries>;

  // Introspection
  list(): (keyof Entries)[];
  clear(): void;
}

type ServiceFactory<T, Entries extends Record<string, unknown>> = (container: Container<Entries>) => T | Promise<T>;

interface ServiceRegistration<T> {
  type: "instance" | "factory" | "singleton";
  value: T | ServiceFactory<T, any>;
  singleton?: T;
}

export class DIContainer<Entries extends Record<string, unknown> = Record<string, unknown>>
  implements Container<Entries> {
  private services = new Map<string, ServiceRegistration<unknown>>();
  private parent: DIContainer<any> | null;
  private disposed = false;

  constructor(parent?: DIContainer<any>) {
    this.parent = parent ?? null;
  }

  /* ───────────────────────────────── Registration ───────────────────────────── */

  register<T>(name: string, instance: T): void {
    this.assertAlive();
    this.services.set(name, { type: "instance", value: instance });
  }

  registerFactory<T, E extends Entries = Entries>(
    name: string,
    factory: ServiceFactory<T, E>,
  ): void {
    this.assertAlive();
    this.services.set(name, { type: "factory", value: factory });
  }

  registerSingleton<T, E extends Entries = Entries>(
    name: string,
    factory: ServiceFactory<T, E>,
  ): void {
    if (factory.toString().includes("tenant")) {
      console.warn(`[DI] Singleton '${name}' depends on tenant — this is unsafe.`);
    }
    this.assertAlive();
    this.services.set(name, { type: "singleton", value: factory });
  }

  /* ───────────────────────────────── Resolution ───────────────────────────── */

  resolve<T, K extends keyof Entries = keyof Entries>(name: K): T extends object ? T : Entries[K] {
    type R = T extends object ? T : Entries[K];
    const reg = this.getRegistrationDeep(String(name));

    if (!reg) {
      throw new Error(`Service not found: ${String(name)}`);
    }

    if (reg.type === "instance") {
      return reg.value as R;
    }

    if (reg.type === "factory") {
      const result = (reg.value as ServiceFactory<R, Entries>)(this);
      if (result instanceof Promise) {
        throw new Error(`Service '${String(name)}' is async. Use resolveAsync().`);
      }
      return result;
    }

    // singleton
    if (reg.singleton !== undefined) {
      return reg.singleton as R;
    }

    const result = (reg.value as ServiceFactory<R, Entries>)(this);
    if (result instanceof Promise) {
      throw new Error(`Service '${String(name)}' is async. Use resolveAsync().`);
    }

    reg.singleton = result;
    return result;
  }

  async resolveAsync<T, K extends keyof Entries = keyof Entries>(
    name: K,
  ): Promise<T extends object ? T : Entries[K]> {
    type R = T extends object ? T : Entries[K];
    const reg = this.getRegistrationDeep(String(name));

    if (!reg) {
      throw new Error(`Service not found: ${String(name)}`);
    }

    if (reg.type === "instance") {
      return reg.value as R;
    }

    if (reg.type === "factory") {
      return await Promise.resolve(
        (reg.value as ServiceFactory<R, Entries>)(this),
      );
    }

    // singleton
    if (reg.singleton !== undefined) {
      return reg.singleton as R;
    }

    const result = await Promise.resolve(
      (reg.value as ServiceFactory<R, Entries>)(this),
    );

    reg.singleton = result;
    return result;
  }

  /* ───────────────────────────────── Scoping ───────────────────────────── */

  createChild<ChildEntries extends Record<string, unknown> = Record<string, unknown>>(): Container<ChildEntries> {
    return new DIContainer<ChildEntries>(this);
  }

  getParent(): Container<Entries> | null {
    return this.parent as Container<Entries> | null;
  }

  getParentOrCurrent(): Container<Entries> {
    return (this.parent ?? this) as Container<Entries>;
  }

  /* ───────────────────────────────── Introspection ───────────────────────────── */

  has(name: keyof Entries): boolean {
    return (
      this.services.has(String(name)) ||
      (this.parent?.has(name) ?? false)
    );
  }

  list(): (keyof Entries)[] {
    const local = Array.from(this.services.keys());
    if (!this.parent) {
      return local as (keyof Entries)[];
    }

    const parent = this.parent.list().filter(
      (k) => !this.services.has(String(k)),
    );

    return [...local, ...parent] as (keyof Entries)[];
  }

  /* ───────────────────────────────── Cleanup & Disposal ───────────────────────────── */

  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;

    for (const reg of this.services.values()) {
      const value = reg.singleton ?? reg.value;
      if (typeof value === "object" && value && "dispose" in value) {
        await (value as Disposable).dispose();
      }
    }

    this.services.clear();
  }

  clear(): void {
    this.services.clear();
  }

  /* ───────────────────────────────── Internals ───────────────────────────── */

  private getRegistrationDeep(name: string): ServiceRegistration<unknown> | null {
    const local = this.services.get(name);
    if (local) return local;
    return this.parent?.getRegistrationDeep(name) ?? null;
  }

  private assertAlive() {
    if (this.disposed) {
      throw new Error("Container has been disposed");
    }
  }
}

/* ───────────────────────────────── Factory ───────────────────────────── */

export function createContainer<
  Entries extends Record<string, unknown> = Record<string, unknown>,
>(parent?: DIContainer<any>) {
  return new DIContainer<Entries>(parent);
}
