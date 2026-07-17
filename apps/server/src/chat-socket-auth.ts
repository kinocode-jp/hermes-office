import type { IncomingMessage } from "node:http";
import type { WebSocket } from "ws";
import type { OfficeAuth, OfficeAuthSession } from "./office-auth.js";

export interface ChatSocketAuthGuard {
  readonly signal: AbortSignal;
  isActive(): boolean;
  invalidate(): void;
}

/** Keeps a chat socket tied to the exact live HTTP session that upgraded it. */
export function createChatSocketAuthGuard(
  auth: OfficeAuth,
  request: IncomingMessage,
  expected: OfficeAuthSession,
): ChatSocketAuthGuard {
  const controller = new AbortController();
  const expectedIdentity = sessionIdentity(expected);
  const expiresAt = Date.parse(expected.expiresAt);
  return {
    signal: controller.signal,
    isActive: () => !controller.signal.aborted
      && Number.isFinite(expiresAt)
      && Date.now() < expiresAt
      && sameSession(auth.authenticate(request), expectedIdentity),
    invalidate: () => controller.abort(),
  };
}

export function invalidateChatSocket(
  socket: WebSocket,
  guards: WeakMap<WebSocket, ChatSocketAuthGuard>,
): void {
  guards.get(socket)?.invalidate();
}

type SessionIdentity = Pick<OfficeAuthSession, "csrfToken"> & { principal: OfficeAuthSession["principal"] };

function sessionIdentity(session: OfficeAuthSession): SessionIdentity {
  return { csrfToken: session.csrfToken, principal: { ...session.principal } };
}

function sameSession(current: OfficeAuthSession | undefined, expected: SessionIdentity): boolean {
  return current !== undefined
    && current.csrfToken === expected.csrfToken
    && current.principal.id === expected.principal.id
    && current.principal.tier === expected.principal.tier
    && current.principal.local === expected.principal.local;
}
