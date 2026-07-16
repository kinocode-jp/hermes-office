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
    const lease = this.#newLease(owner, normalizedProfile(profile));
    return this.#claim(lease);
  }

  claimResume(owner: ChatSessionOwner, profile: string | undefined, durableId: string): ChatSessionClaim | undefined {
    const normalized = normalizedProfile(profile);
    const key = durableKey(normalized, durableId);
    const existing = this.#durable.get(key);
    if (existing !== undefined) {
      return existing.owner === owner
        ? this.#claim(existing)
        : undefined;
    }
    const lease = this.#newLease(owner, normalized);
    lease.durableIds.add(durableId);
    this.#durable.set(key, lease);
    return this.#claim(lease);
  }

  bind(
    claim: ChatSessionClaim,
    identities: { storedSessionId?: string; liveSessionId?: string },
    requireStoredIdentity: boolean
  ): "bound" | "conflict" | "invalid" {
    const lease = this.#leaseFor(claim);
    if (lease === undefined || identities.liveSessionId === undefined || (requireStoredIdentity && identities.storedSessionId === undefined)) return "invalid";
    const durable = identities.storedSessionId === undefined ? [] : [durableKey(lease.profile, identities.storedSessionId)];
    const live = [identities.liveSessionId];
    if (durable.some((key) => conflicting(this.#durable.get(key), lease)) || live.some((key) => conflicting(this.#live.get(key), lease))) return "conflict";
    if (identities.storedSessionId !== undefined) {
      lease.durableIds.add(identities.storedSessionId);
      this.#durable.set(durable[0]!, lease);
    }
    lease.liveIds.add(identities.liveSessionId);
    this.#live.set(identities.liveSessionId, lease);
    lease.pending.delete(claim.attempt);
    lease.bound = true;
    return "bound";
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
    for (const token of this.#owners.get(owner) ?? []) {
      const lease = this.#leases.get(token);
      if (lease?.durableIds.has(sessionId)) { this.#releaseLease(lease); return true; }
    }
    return false;
  }

  isLiveOwnedByAnother(owner: ChatSessionOwner, sessionId: string): boolean {
    const live = this.#live.get(sessionId);
    return live !== undefined && live.owner !== owner;
  }

  releaseOwner(owner: ChatSessionOwner): void {
    for (const token of [...(this.#owners.get(owner) ?? [])]) this.#releaseLease(this.#leases.get(token));
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

  #leaseFor(claim: ChatSessionClaim): Lease | undefined {
    const lease = this.#leases.get(claim.token);
    return lease?.owner === claim.owner ? lease : undefined;
  }

  #releaseLease(lease: Lease | undefined): void {
    if (lease === undefined || !this.#leases.delete(lease.token)) return;
    for (const durableId of lease.durableIds) this.#durable.delete(durableKey(lease.profile, durableId));
    for (const liveId of lease.liveIds) if (this.#live.get(liveId) === lease) this.#live.delete(liveId);
    const owned = this.#owners.get(lease.owner);
    owned?.delete(lease.token);
    if (owned?.size === 0) this.#owners.delete(lease.owner);
  }
}

function conflicting(current: Lease | undefined, expected: Lease): boolean {
  return current !== undefined && current !== expected;
}

function normalizedProfile(profile: string | undefined): string {
  return profile ?? DEFAULT_PROFILE;
}

function durableKey(profile: string, durableId: string): string {
  return `${profile}\u0000${durableId}`;
}
