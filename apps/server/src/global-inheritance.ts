import type {
  HermesSettingsAdapter,
  OfficeGlobalSettingsDto,
  OfficeGlobalSettingsStore,
  OfficeGlobalSettingsUpdate,
  OfficePendingSkillOverride,
} from "./hermes-settings.js";
import { HermesSettingsError } from "./hermes-settings.js";

export interface GlobalInheritanceOptions {
  store: OfficeGlobalSettingsStore;
  settings: HermesSettingsAdapter;
  listProfiles(): Promise<string[]>;
}

/**
 * Owns the boundary between Office-global policy and independent Hermes homes.
 * Every mutation is serialized so provenance changes cannot race a global sync.
 */
export class GlobalInheritanceCoordinator {
  readonly #options: GlobalInheritanceOptions;
  #queue: Promise<void> = Promise.resolve();

  constructor(options: GlobalInheritanceOptions) {
    this.#options = options;
  }

  async read(): Promise<OfficeGlobalSettingsDto> {
    const state = await this.#options.store.readMaterialization();
    if (state.pendingSkillOverrides.length === 0) return state.settings;
    return {
      ...state.settings,
      skillSync: {
        state: "pending",
        failures: state.pendingSkillOverrides.slice(0, 100).map((item) => ({
          profile: item.profile,
          skill: item.skill,
          operation: item.desiredEnabled ? "enable" as const : "disable" as const,
        })),
      },
    };
  }

  async sessionCreateContext(): Promise<string | undefined> {
    const settings = await this.#options.store.read();
    if (!settings.sharedContextEnabled || settings.context.trim() === "") return undefined;
    return settings.context;
  }

  async update(input: OfficeGlobalSettingsUpdate): Promise<OfficeGlobalSettingsDto> {
    return await this.#serialized(async () => {
      await this.#reconcilePendingSkillOverrides();
      const staged = await this.#options.store.beginMaterialization(input);
      const desired = new Set(staged.settings.sharedSkillsEnabled ? staged.settings.skills : []);
      const managed = new Map(staged.managedSkills.map((item) => [keyOf(item.profile, item.skill), item]));
      const overrides = new Map(staged.skillOverrides.map((item) => [keyOf(item.profile, item.skill), item]));
      const failures: OfficeGlobalSettingsDto["skillSync"]["failures"] = [];
      let profiles: string[];
      try {
        profiles = uniqueProfiles(await this.#options.listProfiles());
      } catch {
        await this.#options.store.finishMaterialization(staged.settings.revision, [...managed.values()], [...overrides.values()], [{ profile: "default", skill: "profile-discovery", operation: "enable" }]);
        throw unavailable();
      }
      const profileSet = new Set(profiles);
      for (const [key, item] of managed) if (!profileSet.has(item.profile)) managed.delete(key);
      for (const [key, item] of overrides) if (!profileSet.has(item.profile)) overrides.delete(key);

      for (const profile of profiles) {
        let skills;
        try { skills = await this.#options.settings.listSkills(profile); }
        catch {
          for (const skill of desired) failures.push({ profile, skill, operation: "enable" });
          for (const item of managed.values()) if (item.profile === profile && !desired.has(item.skill)) failures.push({ profile, skill: item.skill, operation: "disable" });
          continue;
        }
        const byName = new Map(skills.map((skill) => [skill.name, skill]));

        for (const skill of desired) {
          const key = keyOf(profile, skill);
          const current = byName.get(skill);
          if (overrides.has(key)) {
            managed.delete(key);
            continue;
          }
          if (current === undefined) {
            failures.push({ profile, skill, operation: "enable" });
            continue;
          }
          if (managed.has(key)) {
            // A direct/out-of-band disable is treated as a Profile override.
            if (!current.enabled) {
              managed.delete(key);
              overrides.set(key, { profile, skill });
            }
            continue;
          }
          if (current.enabled) continue; // Already enabled by the Profile/user; never claim it.
          try {
            await this.#options.settings.setSkillEnabled(profile, skill, true, false);
            managed.set(key, { profile, skill });
            await this.#options.store.checkpointMaterialization(staged.settings.revision, [...managed.values()], [...overrides.values()]);
          } catch {
            failures.push({ profile, skill, operation: "enable" });
          }
        }

        for (const item of [...managed.values()]) {
          if (item.profile !== profile || desired.has(item.skill)) continue;
          const current = byName.get(item.skill);
          if (current === undefined || !current.enabled) {
            managed.delete(keyOf(item.profile, item.skill));
            continue;
          }
          try {
            await this.#options.settings.setSkillEnabled(profile, item.skill, false, true);
            managed.delete(keyOf(item.profile, item.skill));
            await this.#options.store.checkpointMaterialization(staged.settings.revision, [...managed.values()], [...overrides.values()]);
          } catch {
            failures.push({ profile, skill: item.skill, operation: "disable" });
          }
        }
      }

      const result = await this.#options.store.finishMaterialization(
        staged.settings.revision,
        [...managed.values()],
        [...overrides.values()],
        dedupeFailures(failures),
      );
      if (result.skillSync.state === "pending") throw unavailable();
      return result;
    });
  }

  /** A Profile-scoped user toggle wins; Office relinquishes this pair. */
  async noteProfileSkillOverride(profile: string, skill: string): Promise<void> {
    await this.#serialized(async () => await this.#options.store.markSkillOverride(profile, skill));
  }

  /** Durable intent protects the user change until Hermes and ownership agree. */
  async applyProfileSkillOverride(
    profile: string,
    skill: string,
    desiredEnabled: boolean,
    expectedEnabled: boolean,
    mutation: () => Promise<void>,
  ): Promise<void> {
    await this.#serialized(async () => {
      const ownership = await this.#options.store.readMaterialization();
      const alreadyOwned = ownership.skillOverrides.some((item) => item.profile === profile && item.skill === skill);
      if (alreadyOwned) {
        try {
          const current = (await this.#options.settings.listSkills(profile)).find((item) => item.name === skill);
          if (current?.enabled === desiredEnabled) return;
        } catch { /* Ownership is already durable; the normal mutation reports runtime failure. */ }
        await mutation();
        return;
      }
      const prepared = await this.#options.store.prepareSkillOverride(profile, skill, desiredEnabled, expectedEnabled);
      if (prepared.existing) {
        await this.#reconcilePendingSkillOverride(prepared.transaction);
        return;
      }
      try {
        await mutation();
      } catch (error) {
        if (isDefinitePreconditionFailure(error)) {
          try { await this.#options.store.abortSkillOverride(prepared.transaction); }
          catch { throw reconciliationPending(); }
          throw error;
        }
        // The upstream outcome can be ambiguous (for example a timeout after
        // applying). Keep the durable intent and make that recovery state explicit.
        throw reconciliationPending();
      }
      await this.#commitSkillOverride(prepared.transaction);
    });
  }

  async #reconcilePendingSkillOverrides(): Promise<void> {
    const state = await this.#options.store.readMaterialization();
    for (const transaction of state.pendingSkillOverrides) {
      await this.#reconcilePendingSkillOverride(transaction);
    }
  }

  async #reconcilePendingSkillOverride(transaction: OfficePendingSkillOverride): Promise<void> {
    let skills;
    try {
      skills = await this.#options.settings.listSkills(transaction.profile);
    } catch {
      throw reconciliationPending();
    }
    const current = skills.find((skill) => skill.name === transaction.skill);
    if (current === undefined) throw reconciliationPending();
    if (current.enabled !== transaction.desiredEnabled) {
      if (current.enabled !== transaction.expectedEnabled) {
        throw new HermesSettingsError("conflict", "Profile skill changed while ownership reconciliation was pending.");
      }
      try {
        await this.#options.settings.setSkillEnabled(
          transaction.profile,
          transaction.skill,
          transaction.desiredEnabled,
          transaction.expectedEnabled,
        );
      } catch {
        throw reconciliationPending();
      }
    }
    await this.#commitSkillOverride(transaction);
  }

  async #commitSkillOverride(transaction: OfficePendingSkillOverride): Promise<void> {
    try {
      await this.#options.store.commitSkillOverride(transaction);
    } catch {
      throw reconciliationPending();
    }
  }

  async #serialized<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.#queue.then(operation);
    this.#queue = result.then(() => undefined, () => undefined);
    return await result;
  }
}

function uniqueProfiles(profiles: string[]): string[] {
  const result = [...new Set(profiles)];
  if (result.length === 0 || result.length > 1_000 || result.some((profile) => !/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(profile))) throw new Error("Invalid Hermes profile inventory.");
  return result;
}

function dedupeFailures(failures: OfficeGlobalSettingsDto["skillSync"]["failures"]): OfficeGlobalSettingsDto["skillSync"]["failures"] {
  const seen = new Set<string>();
  return failures.filter((failure) => { const key = `${failure.profile}\0${failure.skill}\0${failure.operation}`; if (seen.has(key)) return false; seen.add(key); return true; }).slice(0, 100);
}

function keyOf(profile: string, skill: string): string { return `${profile}\0${skill}`; }
function unavailable(): HermesSettingsError { return new HermesSettingsError("rejected", "Global skills are pending synchronization. Retry after checking the affected profiles."); }
function reconciliationPending(): HermesSettingsError { return new HermesSettingsError("rejected", "Profile skill changed, but ownership reconciliation is still pending. Retry safely before global synchronization."); }
function isDefinitePreconditionFailure(error: unknown): boolean {
  return error instanceof HermesSettingsError
    && (error.code === "conflict" || error.code === "invalid_request" || error.code === "not_found");
}
