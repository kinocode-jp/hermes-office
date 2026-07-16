const DEFAULT_PROFILE = "default";

export type CanonicalChatSession = {
  requestedSessionId: string;
  sessionId: string;
  path: readonly string[];
};

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

  claimResume(owner: ChatSessionOwner, profile: string | undefined, identity: CanonicalChatSession): ChatSessionClaim | undefined {
    const normalized = normalizedProfile(profile);
    // Hermes can rotate a stored identity after the read-only descendant probe,
    // and its live lookup is process-global rather than profile-scoped. An
    // unknown tip therefore cannot be proven distinct while another downstream
    // transport owns any lease. One Office WebSocket still multiplexes all of
    // its panes, so same-owner resumes remain available.
    if ([...this.#owners.keys()].some((candidate) => candidate !== owner)) return undefined;
    const aliases = new Set([identity.requestedSessionId, identity.sessionId, ...identity.path]);
    const existing = new Set([...aliases].flatMap((alias) => {
      const lease = this.#durable.get(alias);
      return lease === undefined ? [] : [lease];
    }));
    if (existing.size > 1) return undefined;
    const current = [...existing][0];
    if (current !== undefined) {
      if (current.owner !== owner || current.profile !== normalized) return undefined;
      this.#bindDurableAliases(current, aliases);
      return this.#claim(current);
    }
    const lease = this.#newLease(owner, normalized);
    this.#bindDurableAliases(lease, aliases);
    return this.#claim(lease);
  }

  bind(
    claim: ChatSessionClaim,
    identities: { storedSessionId?: string; liveSessionId?: string },
    requireStoredIdentity: boolean
  ): "bound" | "conflict" | "invalid" {
    const lease = this.#leaseFor(claim);
    if (lease === undefined || identities.liveSessionId === undefined || (requireStoredIdentity && identities.storedSessionId === undefined)) return "invalid";
    const durable = identities.storedSessionId === undefined ? [] : [identities.storedSessionId];
    const live = [identities.liveSessionId];
    if (durable.some((key) => conflicting(this.#durable.get(key), lease)) || live.some((key) => conflicting(this.#live.get(key), lease))) return "conflict";
    if (identities.storedSessionId !== undefined) {
      this.#bindDurableAliases(lease, [identities.storedSessionId]);
    }
    lease.liveIds.add(identities.liveSessionId);
    this.#live.set(identities.liveSessionId, lease);
    lease.pending.delete(claim.attempt);
    lease.bound = true;
    return "bound";
  }

  bindLiveSessionAlias(owner: ChatSessionOwner, liveSessionId: string, durableId: string): "bound" | "conflict" | "unknown" {
    const lease = this.#live.get(liveSessionId);
    if (lease?.owner !== owner) return "unknown";
    if (conflicting(this.#durable.get(durableId), lease)) return "conflict";
    this.#bindDurableAliases(lease, [durableId]);
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

  #bindDurableAliases(lease: Lease, aliases: Iterable<string>): void {
    for (const alias of aliases) {
      lease.durableIds.add(alias);
      this.#durable.set(alias, lease);
    }
  }

  #leaseFor(claim: ChatSessionClaim): Lease | undefined {
    const lease = this.#leases.get(claim.token);
    return lease?.owner === claim.owner ? lease : undefined;
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

function conflicting(current: Lease | undefined, expected: Lease): boolean {
  return current !== undefined && current !== expected;
}

function normalizedProfile(profile: string | undefined): string {
  return profile ?? DEFAULT_PROFILE;
}
