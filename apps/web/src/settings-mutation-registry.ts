export type SettingsMutationScope = string;

export class SettingsMutationRegistry {
  readonly #keys = new Map<string, SettingsMutationScope>();
  readonly #scopes = new Set<SettingsMutationScope>();

  start(key: string, scope: SettingsMutationScope): boolean {
    if (this.#keys.has(key) || this.#scopes.has(scope)) return false;
    this.#keys.set(key, scope);
    this.#scopes.add(scope);
    return true;
  }

  finish(key: string): void {
    const scope = this.#keys.get(key);
    if (scope === undefined) return;
    this.#keys.delete(key);
    this.#scopes.delete(scope);
  }

  hasKey(key: string): boolean {
    return this.#keys.has(key);
  }

  hasScope(scope: SettingsMutationScope): boolean {
    return this.#scopes.has(scope);
  }

  snapshot(): ReadonlySet<string> {
    return new Set(this.#keys.keys());
  }
}
