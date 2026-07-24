import type { ServerResponse } from "node:http";
import type { HermesRuntimeSource } from "./hermes-backend.js";
import { writeError, writeJson } from "./server-http.js";

const PROFILE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const SESSION_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const SESSION_PATH = /^\/api\/v1\/sessions\/([^/]+)$/;

export function isSessionResourcePath(pathname: string): boolean {
  return SESSION_PATH.test(pathname);
}

export async function handleSessionDelete(
  response: ServerResponse,
  requestUrl: URL,
  runtime: HermesRuntimeSource | undefined,
  maxJsonBytes: number,
  maxResponseJsonBytes: number,
): Promise<void> {
  const match = SESSION_PATH.exec(requestUrl.pathname);
  if (match === null) {
    writeError(response, 404, "not_found", "Route not found.", maxJsonBytes);
    return;
  }

  let sessionId: string;
  try {
    sessionId = decodeURIComponent(match[1]!);
  } catch {
    writeError(response, 400, "bad_request", "Session identifier is malformed.", maxJsonBytes);
    return;
  }
  if (!SESSION_ID_PATTERN.test(sessionId)) {
    writeError(response, 400, "bad_request", "Session identifier is invalid.", maxJsonBytes);
    return;
  }

  const profile = (requestUrl.searchParams.get("profile") ?? "default").trim();
  if (!PROFILE_PATTERN.test(profile)) {
    writeError(response, 400, "bad_request", "profile is invalid.", maxJsonBytes);
    return;
  }

  if (runtime?.deleteSession === undefined) {
    writeError(response, 503, "runtime_unavailable", "Hermes runtime is unavailable.", maxJsonBytes);
    return;
  }

  try {
    await runtime.deleteSession(profile, sessionId);
    writeJson(response, 200, { ok: true, profile, sessionId }, maxResponseJsonBytes, {
      "Cache-Control": "no-store",
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unable to delete session.";
    if (/invalid/i.test(message)) {
      writeError(response, 400, "bad_request", message, maxJsonBytes);
      return;
    }
    writeError(response, 502, "runtime_unavailable", "Hermes rejected the session delete request.", maxJsonBytes);
  }
}
