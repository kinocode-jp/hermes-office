const DEFAULT_PROFILE = "default";

export type ChatSessionOwner = object;

export type ChatSessionClaim = {
  readonly token: symbol;
  readonly attempt: symbol;
  readonly owner: ChatSessionOwner;
};

export type ChatSessionLeaseSnapshot = {
  readonly token: symbol;
  readonly owner: ChatSessionOwner;
  readonly liveSessionIds: readonly string[];
  readonly pending: boolean;
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
  readonly #durable = new Map<string, Map<string, Lease>>();
  readonly #live = new Map<string, Lease>();
  readonly #leases = new Map<symbol, Lease>();
  readonly #owners = new Map<ChatSessionOwner, Set<symbol>>();
  readonly #closingLive = new Map<string, symbol>();

  claimCreate(owner: ChatSessionOwner, profile: string | undefined): ChatSessionClaim {
    return this.#claim(this.#newLease(owner, normalizedProfile(profile)));
  }

  claimResume(owner: ChatSessionOwner, profile: string | undefined, requestedId: string): ChatSessionClaim | undefined {
    const normalized = normalizedProfile(profile);
    const existing = this.#durableLease(normalized, requestedId);
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
      const current = this.#durableLease(lease.profile, alias);
      if (current !== undefined && current !== lease) conflicts.add(current);
    }
    const liveLease = this.#live.get(identities.liveSessionId);
    if (liveLease !== undefined && liveLease !== lease) conflicts.add(liveLease);
    const liveClosing = this.#closingLive.has(identities.liveSessionId);
    const changesBoundLive = lease.bound && lease.liveIds.size > 0 && !lease.liveIds.has(identities.liveSessionId);

    if (conflicts.size === 0 && !liveClosing && !changesBoundLive) {
      this.#bindDurableAliases(lease, aliases);
      this.#bindLiveAlias(lease, identities.liveSessionId);
      lease.pending.delete(claim.attempt);
      lease.bound = true;
      return "bound";
    }

    if (lease.bound) {
      // A second Hermes live id is a distinct `_sessions` entry, not an alias
      // for the pane's established transport. Durable rotation can converge,
      // but the duplicate live session must be closed by the Hub.
      if (conflicts.size === 0) this.#bindDurableAliases(lease, aliases);
      lease.pending.delete(claim.attempt);
      return "conflict";
    }

    const existing = [...conflicts][0];
    if (conflicts.size === 1 && existing !== undefined && !lease.bound) {
      // The native Hermes resolver may return a compression-rotated identity
      // that Office has never observed. A shared upstream makes its transport
      // rebind harmless, so consolidate durable identity only inside the same
      // Profile after the authoritative response. A different live id remains
      // a distinct duplicate session for the Hub to close.
      if (existing.profile === lease.profile) this.#bindDurableAliases(existing, aliases);
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

  ownerForLive(sessionId: string): ChatSessionOwner | undefined {
    return this.#live.get(sessionId)?.owner;
  }

  liveLeaseToken(owner: ChatSessionOwner, liveSessionId: string): symbol | undefined {
    const lease = this.#live.get(liveSessionId);
    return lease?.owner === owner ? lease.token : undefined;
  }

  ownsLiveLease(owner: ChatSessionOwner, liveSessionId: string, token: symbol): boolean {
    const lease = this.#live.get(liveSessionId);
    return lease?.owner === owner && lease.token === token;
  }

  isOwnedByAnother(owner: ChatSessionOwner, sessionId: string): boolean {
    const lease = this.#live.get(sessionId);
    return lease !== undefined && lease.owner !== owner;
  }

  ownedLiveSessionIds(owner: ChatSessionOwner): string[] {
    const ids = new Set<string>();
    for (const token of this.#owners.get(owner) ?? []) {
      for (const liveId of this.#leases.get(token)?.liveIds ?? []) ids.add(liveId);
    }
    return [...ids];
  }

  ownedSessionLeases(owner: ChatSessionOwner): ChatSessionLeaseSnapshot[] {
    const snapshots: ChatSessionLeaseSnapshot[] = [];
    for (const token of this.#owners.get(owner) ?? []) {
      const lease = this.#leases.get(token);
      if (lease !== undefined && lease.liveIds.size > 0) snapshots.push(this.#snapshot(lease));
    }
    return snapshots;
  }

  leaseForSession(owner: ChatSessionOwner, sessionId: string): ChatSessionLeaseSnapshot | undefined {
    const lease = this.#live.get(sessionId);
    return lease?.owner === owner ? this.#snapshot(lease) : undefined;
  }

  releaseLease(owner: ChatSessionOwner, token: symbol): boolean {
    const lease = this.#leases.get(token);
    if (lease?.owner !== owner) return false;
    this.#releaseLease(lease);
    return true;
  }

  claimOwnedLeaseClose(owner: ChatSessionOwner, snapshot: ChatSessionLeaseSnapshot): symbol | undefined {
    const lease = this.#leases.get(snapshot.token);
    if (lease?.owner !== owner || lease.liveIds.size !== snapshot.liveSessionIds.length
      || snapshot.liveSessionIds.length === 0) return undefined;
    for (const liveId of snapshot.liveSessionIds) {
      if (this.#live.get(liveId) !== lease || this.#closingLive.has(liveId)) return undefined;
    }
    const token = Symbol("chat-owned-live-close");
    // Keep this reservation even if the lease is released while Hermes I/O is
    // pending, so the same live id cannot bind to a replacement lease.
    for (const liveId of snapshot.liveSessionIds) this.#closingLive.set(liveId, token);
    return token;
  }

  finishOwnedLeaseClose(snapshot: ChatSessionLeaseSnapshot, token: symbol): void {
    for (const liveId of snapshot.liveSessionIds) {
      if (this.#closingLive.get(liveId) === token) this.#closingLive.delete(liveId);
    }
  }

  claimUnownedLiveClose(liveSessionId: string): symbol | undefined {
    if (this.#live.has(liveSessionId) || this.#closingLive.has(liveSessionId)) return undefined;
    const token = Symbol("chat-live-close");
    this.#closingLive.set(liveSessionId, token);
    return token;
  }

  finishUnownedLiveClose(liveSessionId: string, token: symbol): void {
    if (this.#closingLive.get(liveSessionId) === token) this.#closingLive.delete(liveSessionId);
  }

  releaseOwner(owner: ChatSessionOwner): void {
    for (const token of [...(this.#owners.get(owner) ?? [])]) this.#releaseLease(this.#leases.get(token));
  }

  releaseAll(): void {
    for (const lease of [...this.#leases.values()]) this.#releaseLease(lease);
    this.#closingLive.clear();
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
    let profileAliases = this.#durable.get(lease.profile);
    if (profileAliases === undefined) {
      profileAliases = new Map();
      this.#durable.set(lease.profile, profileAliases);
    }
    for (const alias of aliases) {
      lease.durableIds.add(alias);
      profileAliases.set(alias, lease);
    }
  }

  #durableLease(profile: string, durableId: string): Lease | undefined {
    return this.#durable.get(profile)?.get(durableId);
  }

  #bindLiveAlias(lease: Lease, liveId: string): void {
    if (lease.liveIds.size > 0 && !lease.liveIds.has(liveId)) throw new Error("A chat lease cannot own multiple live sessions.");
    lease.liveIds.add(liveId);
    this.#live.set(liveId, lease);
  }

  #snapshot(lease: Lease): ChatSessionLeaseSnapshot {
    return { token: lease.token, owner: lease.owner, liveSessionIds: [...lease.liveIds], pending: lease.pending.size > 0 };
  }

  #leaseFor(claim: ChatSessionClaim): Lease | undefined {
    const lease = this.#leases.get(claim.token);
    return lease?.owner === claim.owner && lease.pending.has(claim.attempt) ? lease : undefined;
  }

  #releaseLease(lease: Lease | undefined): void {
    if (lease === undefined || !this.#leases.delete(lease.token)) return;
    const profileAliases = this.#durable.get(lease.profile);
    for (const durableId of lease.durableIds) {
      if (profileAliases?.get(durableId) === lease) profileAliases.delete(durableId);
    }
    if (profileAliases?.size === 0) this.#durable.delete(lease.profile);
    for (const liveId of lease.liveIds) if (this.#live.get(liveId) === lease) this.#live.delete(liveId);
    const owned = this.#owners.get(lease.owner);
    owned?.delete(lease.token);
    if (owned?.size === 0) this.#owners.delete(lease.owner);
  }
}

function normalizedProfile(profile: string | undefined): string {
  return profile ?? DEFAULT_PROFILE;
}
