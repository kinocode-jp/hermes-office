const DEFAULT_PROFILE = "default";

export type ChatSessionOwner = object;

export type ChatSessionClaim = {
  readonly token: symbol;
  readonly attempt: symbol;
  readonly owner: ChatSessionOwner;
};

type Lease = {
  token: symbol;
  owner: ChatSessionOwner;
  profile: string;
  durableIds: Set<string>;
  liveIds: Set<string>;
  pending: Set<symbol>;
  bound: boolean;
};

export class ChatSessionCoordinator {
  readonly #durable = new Map<string, Lease>();
  readonly #live = new Map<string, Lease>();
  readonly #leases = new Map<symbol, Lease>();
  readonly #owners = new Map<ChatSessionOwner, Set<symbol>>();

  claimCreate(owner: ChatSessionOwner, profile: string | undefined): ChatSessionClaim {
    return this.#claim(this.#newLease(owner, normalizedProfile(profile)));
  }

  claimResume(owner: ChatSessionOwner, profile: string | undefined, requestedId: string): ChatSessionClaim | undefined {
    const normalized = normalizedProfile(profile);
    const existing = this.#durable.get(requestedId);
    if (existing !== undefined) {
      return existing.owner === owner && existing.profile === normalized
        ? this.#claim(existing)
        : undefined;
    }
    const lease = this.#newLease(owner, normalized);
    this.#bindDurableAliases(lease, [requestedId]);
    return this.#claim(lease);
  }

  bind(
    claim: ChatSessionClaim,
    identities: { storedSessionId?: string; liveSessionId?: string },
    requireStoredIdentity: boolean,
  ): "bound" | "conflict" | "invalid" {
    const lease = this.#leaseFor(claim);
    if (lease === undefined || identities.liveSessionId === undefined || (requireStoredIdentity && identities.storedSessionId === undefined)) return "invalid";
    const aliases = new Set(lease.durableIds);
    if (identities.storedSessionId !== undefined) aliases.add(identities.storedSessionId);
    const conflicts = new Set<Lease>();
    for (const alias of aliases) {
      const current = this.#durable.get(alias);
      if (current !== undefined && current !== lease) conflicts.add(current);
    }
    const liveLease = this.#live.get(identities.liveSessionId);
    if (liveLease !== undefined && liveLease !== lease) conflicts.add(liveLease);

    if (conflicts.size === 0) {
      this.#bindDurableAliases(lease, aliases);
      this.#bindLiveAlias(lease, identities.liveSessionId);
      lease.pending.delete(claim.attempt);
      lease.bound = true;
      return "bound";
    }

    const existing = [...conflicts][0];
    if (conflicts.size === 1 && existing !== undefined && !lease.bound) {
      // The native Hermes resolver may return a compression-rotated identity
      // that Office has never observed. A shared upstream makes its transport
      // rebind harmless, so consolidate identity only after the authoritative
      // resume response. Cross-owner/profile callers still receive a conflict.
      this.#bindDurableAliases(existing, aliases);
      this.#bindLiveAlias(existing, identities.liveSessionId);
      this.#releaseLease(lease);
      // Even same-owner/profile rotation aliases converge on the existing
      // lease but reject the duplicate resume. Otherwise the Web live-to-pane
      // map would move events away from the already open pane.
      return "conflict";
    }

    lease.pending.delete(claim.attempt);
    if (!lease.bound && lease.pending.size === 0) this.#releaseLease(lease);
    return "conflict";
  }

  releaseFailedClaim(claim: ChatSessionClaim | undefined): void {
    if (claim === undefined) return;
    const lease = this.#leaseFor(claim);
    if (lease === undefined) return;
    lease.pending.delete(claim.attempt);
    if (!lease.bound && lease.pending.size === 0) this.#releaseLease(lease);
  }

  releaseSession(owner: ChatSessionOwner, sessionId: string): boolean {
    const live = this.#live.get(sessionId);
    if (live?.owner === owner) { this.#releaseLease(live); return true; }
    const durable = this.#durable.get(sessionId);
    if (durable?.owner === owner) { this.#releaseLease(durable); return true; }
    return false;
  }

  ownerForLive(sessionId: string): ChatSessionOwner | undefined {
    return this.#live.get(sessionId)?.owner;
  }

  isOwnedByAnother(owner: ChatSessionOwner, sessionId: string): boolean {
    const lease = this.#live.get(sessionId) ?? this.#durable.get(sessionId);
    return lease !== undefined && lease.owner !== owner;
  }

  ownedLiveSessionIds(owner: ChatSessionOwner): string[] {
    const ids = new Set<string>();
    for (const token of this.#owners.get(owner) ?? []) {
      for (const liveId of this.#leases.get(token)?.liveIds ?? []) ids.add(liveId);
    }
    return [...ids];
  }

  releaseOwner(owner: ChatSessionOwner): void {
    for (const token of [...(this.#owners.get(owner) ?? [])]) this.#releaseLease(this.#leases.get(token));
  }

  releaseAll(): void {
    for (const lease of [...this.#leases.values()]) this.#releaseLease(lease);
  }

  #newLease(owner: ChatSessionOwner, profile: string): Lease {
    const lease: Lease = {
      token: Symbol("chat-session-lease"), owner, profile,
      durableIds: new Set(), liveIds: new Set(), pending: new Set(), bound: false,
    };
    this.#leases.set(lease.token, lease);
    const owned = this.#owners.get(owner) ?? new Set<symbol>();
    owned.add(lease.token);
    this.#owners.set(owner, owned);
    return lease;
  }

  #claim(lease: Lease): ChatSessionClaim {
    const attempt = Symbol("chat-session-attempt");
    lease.pending.add(attempt);
    return { token: lease.token, attempt, owner: lease.owner };
  }

  #bindDurableAliases(lease: Lease, aliases: Iterable<string>): void {
    for (const alias of aliases) {
      lease.durableIds.add(alias);
      this.#durable.set(alias, lease);
    }
  }

  #bindLiveAlias(lease: Lease, liveId: string): void {
    lease.liveIds.add(liveId);
    this.#live.set(liveId, lease);
  }

  #leaseFor(claim: ChatSessionClaim): Lease | undefined {
    const lease = this.#leases.get(claim.token);
    return lease?.owner === claim.owner && lease.pending.has(claim.attempt) ? lease : undefined;
  }

  #releaseLease(lease: Lease | undefined): void {
    if (lease === undefined || !this.#leases.delete(lease.token)) return;
    for (const durableId of lease.durableIds) if (this.#durable.get(durableId) === lease) this.#durable.delete(durableId);
    for (const liveId of lease.liveIds) if (this.#live.get(liveId) === lease) this.#live.delete(liveId);
    const owned = this.#owners.get(lease.owner);
    owned?.delete(lease.token);
    if (owned?.size === 0) this.#owners.delete(lease.owner);
  }
}

function normalizedProfile(profile: string | undefined): string {
  return profile ?? DEFAULT_PROFILE;
}
