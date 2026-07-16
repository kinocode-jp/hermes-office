import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";

const COOKIE_NAME = "hermes_office_session";
const SESSION_TTL_MS = 12 * 60 * 60 * 1_000;
const MAX_SESSIONS = 64;
const MAX_AUDIT_RECORDS = 256;
const REMOTE_ATTEMPT_WINDOW_MS = 60_000;
const MAX_REMOTE_ATTEMPTS = 5;
const MAX_RATE_LIMIT_KEYS = 256;
const DESKTOP_CAPABILITY_HEADER = "x-hermes-office-desktop-capability";
const DESKTOP_PROTOCOL_PREFIX = "hermes-office.desktop.";
const DEFAULT_DESKTOP_ORIGINS = ["tauri://localhost", "http://tauri.localhost", "https://tauri.localhost"] as const;

export interface OfficePrincipal {
  id: string;
  tier: "owner";
  local: boolean;
  deviceName: string;
}

export interface OfficeAuthSession {
  principal: OfficePrincipal;
  csrfToken: string;
  expiresAt: string;
}

export interface OfficePublicAuditRecord {
  occurredAt: string;
  operation: "auth.local" | "auth.device" | "auth.logout" | "audit.read";
  outcome: "allowed" | "denied" | "rate_limited";
  deviceName: string | null;
  local: boolean;
}

export interface OfficeAuditRecord extends OfficePublicAuditRecord {
  id: string;
  actorId: string | null;
  deviceId: string | null;
}

export interface OfficeAuthOptions {
  remoteToken?: string;
  desktopCapability?: string;
  desktopOrigins?: readonly string[];
  onAudit?: (record: OfficeAuditRecord) => void;
}

export type DeviceBootstrapResult =
  | { outcome: "success"; session: OfficeAuthSession }
  | { outcome: "disabled" | "invalid" | "rate_limited" };

interface StoredSession extends OfficeAuthSession {
  expiresAtMs: number;
}

interface AttemptWindow {
  count: number;
  resetAt: number;
}

export class OfficeAuth {
  readonly #sessions = new Map<string, StoredSession>();
  readonly #remoteTokenDigest: Buffer | undefined;
  readonly #desktopCapabilityDigest: Buffer | undefined;
  readonly #desktopSession: OfficeAuthSession | undefined;
  readonly #desktopOrigins: ReadonlySet<string>;
  readonly #onAudit: ((record: OfficeAuditRecord) => void) | undefined;
  readonly #audit: OfficeAuditRecord[] = [];
  readonly #attempts = new Map<string, AttemptWindow>();

  constructor(options: OfficeAuthOptions = {}) {
    this.#desktopOrigins = validateDesktopOrigins(options.desktopOrigins ?? DEFAULT_DESKTOP_ORIGINS);
    const remoteToken = options.remoteToken;
    if (remoteToken !== undefined) {
      if (remoteToken.length < 32 || remoteToken.length > 4_096 || remoteToken.includes("\0")) {
        throw new Error("Remote access token must contain 32 to 4096 characters.");
      }
      this.#remoteTokenDigest = secretDigest(remoteToken);
    }
    const desktopCapability = options.desktopCapability;
    if (desktopCapability !== undefined) {
      if (!isValidDesktopCapability(desktopCapability)) {
        throw new Error("Desktop capability must contain 32 to 256 URL-safe characters.");
      }
      this.#desktopCapabilityDigest = secretDigest(desktopCapability);
      this.#desktopSession = {
        principal: { id: "local-desktop", tier: "owner", local: true, deviceName: "Local desktop" },
        // Desktop mutations are protected by the launch-scoped capability and
        // an exact Tauri origin check, rather than a cross-site cookie CSRF token.
        csrfToken: randomBytes(24).toString("base64url"),
        expiresAt: new Date(Date.now() + SESSION_TTL_MS).toISOString(),
      };
    }
    this.#onAudit = options.onAudit;
  }

  get remoteEnabled(): boolean {
    return this.#remoteTokenDigest !== undefined;
  }

  bootstrapLocal(request: IncomingMessage, response: ServerResponse): OfficeAuthSession | undefined {
    if (!isTrustedLocalRequest(request)) {
      this.#appendAudit("auth.local", "denied", undefined, true);
      return undefined;
    }
    const session = this.#issueSession(request, response, "Local desktop", true);
    this.#appendAudit("auth.local", "allowed", session, true);
    return session;
  }

  bootstrapDevice(
    request: IncomingMessage,
    response: ServerResponse,
    credentials: { token: string; deviceName: string },
  ): DeviceBootstrapResult {
    if (this.#remoteTokenDigest === undefined) return { outcome: "disabled" };
    const rateKey = request.socket.remoteAddress?.slice(0, 128) || "unknown";
    if (!this.#consumeAttempt(rateKey)) {
      this.#appendAudit("auth.device", "rate_limited", undefined, false);
      return { outcome: "rate_limited" };
    }

    const candidate = secretDigest(credentials.token);
    if (!timingSafeEqual(candidate, this.#remoteTokenDigest)) {
      this.#appendAudit("auth.device", "denied", undefined, false);
      return { outcome: "invalid" };
    }

    const deviceName = normalizeDeviceName(credentials.deviceName);
    if (deviceName === undefined) {
      this.#appendAudit("auth.device", "denied", undefined, false);
      return { outcome: "invalid" };
    }
    const session = this.#issueSession(request, response, deviceName, false);
    this.#appendAudit("auth.device", "allowed", session, false);
    return { outcome: "success", session };
  }

  authenticate(request: IncomingMessage): OfficeAuthSession | undefined {
    const desktop = this.#authenticateDesktop(request);
    if (desktop !== undefined) return desktop;
    this.#prune();
    const rawToken = readCookie(request.headers.cookie, COOKIE_NAME);
    if (rawToken === undefined || rawToken.length > 128) return undefined;
    const stored = this.#sessions.get(tokenDigest(rawToken));
    return stored === undefined ? undefined : publicSession(stored);
  }

  authorizeMutation(request: IncomingMessage): OfficeAuthSession | undefined {
    const desktop = this.#authenticateDesktop(request);
    if (desktop !== undefined) return desktop;
    const session = this.authenticate(request);
    const supplied = request.headers["x-csrf-token"];
    if (session === undefined || typeof supplied !== "string") return undefined;
    return safeEqual(supplied, session.csrfToken) ? session : undefined;
  }

  #authenticateDesktop(request: IncomingMessage): OfficeAuthSession | undefined {
    if (this.#desktopCapabilityDigest === undefined || this.#desktopSession === undefined) return undefined;
    if (!isTrustedDesktopRequest(request, this.#desktopOrigins)) return undefined;
    const supplied = readDesktopCapability(request);
    if (supplied === undefined || !isValidDesktopCapability(supplied)) return undefined;
    return timingSafeEqual(secretDigest(supplied), this.#desktopCapabilityDigest)
      ? {
          ...this.#desktopSession,
          principal: { ...this.#desktopSession.principal },
          // The capability itself is launch-scoped. Keep individual WebSocket
          // leases bounded while allowing a long-running desktop app to renew.
          expiresAt: new Date(Date.now() + SESSION_TTL_MS).toISOString(),
        }
      : undefined;
  }

  readAudit(session: OfficeAuthSession): { records: OfficePublicAuditRecord[] } | undefined {
    if (session.principal.tier !== "owner") return undefined;
    this.#appendAudit("audit.read", "allowed", session, session.principal.local);
    return { records: this.#audit.map(publicAuditRecord) };
  }

  revoke(request: IncomingMessage, response: ServerResponse): boolean {
    const session = this.authenticate(request);
    const rawToken = readCookie(request.headers.cookie, COOKIE_NAME);
    if (rawToken === undefined) return false;
    const removed = this.#sessions.delete(tokenDigest(rawToken));
    response.setHeader("Set-Cookie", `${COOKIE_NAME}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0`);
    this.#appendAudit("auth.logout", removed ? "allowed" : "denied", session, session?.principal.local ?? false);
    return removed;
  }

  #issueSession(
    request: IncomingMessage,
    response: ServerResponse,
    deviceName: string,
    local: boolean,
  ): OfficeAuthSession {
    this.#prune();
    if (this.#sessions.size >= MAX_SESSIONS) this.#dropOldest();
    const rawSessionToken = randomBytes(32).toString("base64url");
    const csrfToken = randomBytes(24).toString("base64url");
    const expiresAtMs = Date.now() + SESSION_TTL_MS;
    const stored: StoredSession = {
      principal: {
        id: `${local ? "local" : "device"}-${randomBytes(8).toString("hex")}`,
        tier: "owner",
        local,
        deviceName,
      },
      csrfToken,
      expiresAt: new Date(expiresAtMs).toISOString(),
      expiresAtMs,
    };
    this.#sessions.set(tokenDigest(rawSessionToken), stored);
    response.setHeader("Set-Cookie", serializeCookie(rawSessionToken, request));
    return publicSession(stored);
  }

  #consumeAttempt(key: string): boolean {
    const now = Date.now();
    for (const [entryKey, window] of this.#attempts) {
      if (window.resetAt <= now) this.#attempts.delete(entryKey);
    }
    if (this.#attempts.size >= MAX_RATE_LIMIT_KEYS && !this.#attempts.has(key)) {
      const oldest = this.#attempts.keys().next();
      if (!oldest.done) this.#attempts.delete(oldest.value);
    }
    const current = this.#attempts.get(key);
    if (current === undefined || current.resetAt <= now) {
      this.#attempts.set(key, { count: 1, resetAt: now + REMOTE_ATTEMPT_WINDOW_MS });
      return true;
    }
    if (current.count >= MAX_REMOTE_ATTEMPTS) return false;
    current.count += 1;
    return true;
  }

  #appendAudit(
    operation: OfficeAuditRecord["operation"],
    outcome: OfficeAuditRecord["outcome"],
    session: OfficeAuthSession | undefined,
    local: boolean,
  ): void {
    const principal = session?.principal;
    const record: OfficeAuditRecord = {
      id: `audit-${randomBytes(8).toString("hex")}`,
      occurredAt: new Date().toISOString(),
      operation,
      outcome,
      actorId: principal?.id ?? null,
      deviceId: principal?.id ?? null,
      deviceName: principal?.deviceName ?? null,
      local,
    };
    this.#audit.push(record);
    if (this.#audit.length > MAX_AUDIT_RECORDS) this.#audit.shift();
    try { this.#onAudit?.({ ...record }); } catch { /* Audit observers cannot affect authentication. */ }
  }

  #prune(): void {
    const now = Date.now();
    for (const [key, session] of this.#sessions) if (session.expiresAtMs <= now) this.#sessions.delete(key);
  }

  #dropOldest(): void {
    const first = this.#sessions.keys().next();
    if (!first.done) this.#sessions.delete(first.value);
  }
}

function publicAuditRecord(record: OfficeAuditRecord): OfficePublicAuditRecord {
  return {
    occurredAt: record.occurredAt,
    operation: record.operation,
    outcome: record.outcome,
    deviceName: record.deviceName,
    local: record.local,
  };
}

function publicSession(session: StoredSession): OfficeAuthSession {
  return {
    principal: { ...session.principal },
    csrfToken: session.csrfToken,
    expiresAt: session.expiresAt,
  };
}

function serializeCookie(token: string, request: IncomingMessage): string {
  const forwardedProto = request.headers["x-forwarded-proto"];
  const secure = ("encrypted" in request.socket && request.socket.encrypted === true) || forwardedProto === "https";
  return `${COOKIE_NAME}=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${Math.floor(SESSION_TTL_MS / 1_000)}${secure ? "; Secure" : ""}`;
}

function readCookie(header: string | undefined, name: string): string | undefined {
  if (header === undefined || header.length > 4_096) return undefined;
  for (const part of header.split(";")) {
    const separator = part.indexOf("=");
    if (separator < 1) continue;
    if (part.slice(0, separator).trim() === name) return part.slice(separator + 1).trim();
  }
  return undefined;
}

function tokenDigest(token: string): string {
  return createHash("sha256").update(token).digest("base64url");
}

function secretDigest(token: string): Buffer {
  return createHash("sha256").update(token, "utf8").digest();
}

function safeEqual(left: string, right: string): boolean {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
}

function isLoopbackAddress(value: string | undefined): boolean {
  if (value === undefined) return false;
  const normalized = value.toLowerCase();
  return normalized === "127.0.0.1" || normalized === "::1" || normalized === "::ffff:127.0.0.1";
}

function isTrustedLocalRequest(request: IncomingMessage): boolean {
  if (!isLoopbackAddress(request.socket.remoteAddress)) return false;
  if (!isTrustedLocalOrigin(request.headers.origin) || !isTrustedLocalHost(request.headers.host)) return false;
  return request.headers.forwarded === undefined
    && request.headers["x-forwarded-for"] === undefined
    && request.headers["x-forwarded-host"] === undefined
    && request.headers["x-real-ip"] === undefined;
}

function isTrustedDesktopRequest(request: IncomingMessage, allowedOrigins: ReadonlySet<string>): boolean {
  if (!isLoopbackAddress(request.socket.remoteAddress)) return false;
  if (request.headers.origin === undefined || !allowedOrigins.has(request.headers.origin) || !isTrustedLocalHost(request.headers.host)) return false;
  return request.headers.forwarded === undefined
    && request.headers["x-forwarded-for"] === undefined
    && request.headers["x-forwarded-host"] === undefined
    && request.headers["x-real-ip"] === undefined;
}

function validateDesktopOrigins(values: readonly string[]): ReadonlySet<string> {
  const origins = new Set<string>();
  for (const value of values) {
    if (!isTrustedLocalOrigin(value)) throw new Error("Desktop origins must be explicit trusted local origins.");
    origins.add(value);
  }
  if (origins.size === 0) throw new Error("At least one desktop origin is required.");
  return origins;
}

function readDesktopCapability(request: IncomingMessage): string | undefined {
  const header = request.headers[DESKTOP_CAPABILITY_HEADER];
  if (typeof header === "string") return header;
  const protocol = request.headers["sec-websocket-protocol"];
  if (typeof protocol !== "string" || protocol.length > 512) return undefined;
  for (const candidate of protocol.split(",").map((value) => value.trim())) {
    if (candidate.startsWith(DESKTOP_PROTOCOL_PREFIX)) return candidate.slice(DESKTOP_PROTOCOL_PREFIX.length);
  }
  return undefined;
}

function isValidDesktopCapability(value: string): boolean {
  return value.length >= 32 && value.length <= 256 && /^[A-Za-z0-9_-]+$/.test(value);
}

function isTrustedLocalHost(value: string | undefined): boolean {
  if (value === undefined || value.length > 256) return false;
  try {
    const parsed = new URL(`http://${value}`);
    return parsed.username === ""
      && parsed.password === ""
      && parsed.pathname === "/"
      && (parsed.hostname === "localhost"
        || parsed.hostname === "127.0.0.1"
        || parsed.hostname === "tauri.localhost");
  } catch {
    return false;
  }
}

function isTrustedLocalOrigin(value: string | undefined): boolean {
  if (value === undefined) return false;
  if (["tauri://localhost", "http://tauri.localhost", "https://tauri.localhost"].includes(value)) return true;
  try {
    const origin = new URL(value);
    return (origin.protocol === "http:" || origin.protocol === "https:")
      && (origin.hostname === "localhost" || origin.hostname === "127.0.0.1")
      && origin.username === ""
      && origin.password === ""
      && origin.pathname === "/"
      && origin.search === ""
      && origin.hash === "";
  } catch {
    return false;
  }
}

function normalizeDeviceName(value: string): string | undefined {
  const name = value.trim();
  if (name.length < 1 || name.length > 64 || /[\u0000-\u001f\u007f]/.test(name)) return undefined;
  return name;
}
