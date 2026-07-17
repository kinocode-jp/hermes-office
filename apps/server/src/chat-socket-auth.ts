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
  return {
    signal: controller.signal,
    isActive: () => !controller.signal.aborted && sameSession(auth.authenticate(request), expected),
    invalidate: () => controller.abort(),
  };
}

export function invalidateChatSocket(
  socket: WebSocket,
  guards: WeakMap<WebSocket, ChatSocketAuthGuard>,
): void {
  guards.get(socket)?.invalidate();
}

function sameSession(current: OfficeAuthSession | undefined, expected: OfficeAuthSession): boolean {
  return current !== undefined
    && current.csrfToken === expected.csrfToken
    && current.expiresAt === expected.expiresAt
    && current.principal.id === expected.principal.id
    && current.principal.tier === expected.principal.tier
    && current.principal.local === expected.principal.local;
}
