import type { IncomingMessage } from "node:http";
import {
  GLOBAL_SETTINGS_MAX_REQUEST_UTF8_BYTES,
  GLOBAL_SETTINGS_MAX_SKILLS,
  isGlobalContextWithinBudget,
} from "@hermes-office/protocol";
import type {
  HermesSettingsAdapter,
  OfficeGlobalSettingsStore,
} from "./hermes-settings.js";
import { HermesSettingsError } from "./hermes-settings.js";
import type { GlobalInheritanceCoordinator } from "./global-inheritance.js";

export interface SettingsHttpDependencies {
  settings: HermesSettingsAdapter;
  globalSettings: OfficeGlobalSettingsStore;
  globalInheritance?: GlobalInheritanceCoordinator;
}

export interface SettingsHttpResult {
  status: number;
  body: unknown;
  headers?: Record<string, string>;
  changed?: { kind: "global" | "memory" | "skill" | "soul"; profile?: string; id?: string };
}

export function isSettingsHttpPath(pathname: string): boolean {
  return pathname === "/api/v1/settings/global" || /^\/api\/v1\/profiles\/[^/]+\/(?:settings|skills|soul|memory)(?:\/|$)/.test(pathname);
}

export function isSettingsMutation(method: string | undefined): boolean {
  return method === "PATCH" || method === "POST" || method === "PUT" || method === "DELETE";
}

export async function routeSettingsHttp(
  request: IncomingMessage,
  url: URL,
  dependencies: SettingsHttpDependencies,
  maxBodyBytes: number,
): Promise<SettingsHttpResult> {
  try {
    if (url.pathname === "/api/v1/settings/global") {
      if (request.method === "GET") return ok(await (dependencies.globalInheritance?.read() ?? dependencies.globalSettings.read()));
      if (request.method === "PATCH") {
        const body = await readObject(request, Math.min(maxBodyBytes, GLOBAL_SETTINGS_MAX_REQUEST_UTF8_BYTES));
        assertOnlyKeys(body, ["expectedRevision", "sharedSkillsEnabled", "sharedContextEnabled", "skills", "context"]);
        const update = {
          expectedRevision: requiredInteger(body.expectedRevision, "expectedRevision", 0),
          ...(body.sharedSkillsEnabled === undefined ? {} : { sharedSkillsEnabled: requiredBoolean(body.sharedSkillsEnabled, "sharedSkillsEnabled") }),
          ...(body.sharedContextEnabled === undefined ? {} : { sharedContextEnabled: requiredBoolean(body.sharedContextEnabled, "sharedContextEnabled") }),
          ...(body.skills === undefined ? {} : { skills: requiredStringArray(body.skills, "skills", GLOBAL_SETTINGS_MAX_SKILLS) }),
          ...(body.context === undefined ? {} : { context: requiredGlobalContext(body.context) }),
        };
        const updated = dependencies.globalInheritance === undefined
          ? await dependencies.globalSettings.update(update)
          : await dependencies.globalInheritance.update(update);
        return { ...ok(updated), changed: { kind: "global" } };
      }
      return methodNotAllowed("GET, PATCH");
    }

    const segments = decodeSegments(url.pathname);
    if (segments.length < 5 || segments[0] !== "api" || segments[1] !== "v1" || segments[2] !== "profiles") return notFound();
    const profile = segments[3]!;
    const resource = segments[4]!;

    if (resource === "settings" && segments.length === 5) {
      if (request.method !== "GET") return methodNotAllowed("GET");
      return ok(await dependencies.settings.getProfileSettings(profile));
    }

    if (resource === "skills") {
      if (segments.length === 5) {
        if (request.method !== "GET") return methodNotAllowed("GET");
        return ok(await dependencies.settings.listSkills(profile));
      }
      const skill = segments[5]!;
      if (segments.length === 6) {
        if (request.method !== "PATCH") return methodNotAllowed("PATCH");
        const body = await readObject(request, maxBodyBytes);
        assertOnlyKeys(body, ["enabled", "expectedEnabled"]);
        const enabled = requiredBoolean(body.enabled, "enabled");
        const expectedEnabled = requiredBoolean(body.expectedEnabled, "expectedEnabled");
        const mutation = async (): Promise<void> =>
          await dependencies.settings.setSkillEnabled(profile, skill, enabled, expectedEnabled);
        if (dependencies.globalInheritance === undefined) await mutation();
        else await dependencies.globalInheritance.applyProfileSkillOverride(profile, skill, mutation);
        return { ...ok({ ok: true, name: skill, enabled }), changed: { kind: "skill", profile, id: skill } };
      }
      if (segments.length === 7 && segments[6] === "content") {
        if (request.method === "GET") return ok(await dependencies.settings.getSkillContent(profile, skill));
        if (request.method === "PUT") {
          const body = await readObject(request, maxBodyBytes);
          assertOnlyKeys(body, ["content", "expectedRevision"]);
          await dependencies.settings.updateSkillContent(
            profile,
            skill,
            requiredString(body.content, "content", 512 * 1024, true),
            requiredRevision(body.expectedRevision),
          );
          const updated = await dependencies.settings.getSkillContent(profile, skill);
          return { ...ok(updated), changed: { kind: "skill", profile, id: skill } };
        }
        return methodNotAllowed("GET, PUT");
      }
      return notFound();
    }

    if (resource === "soul" && segments.length === 5) {
      if (request.method === "GET") return ok(await dependencies.settings.getProfileSoul(profile));
      if (request.method === "PUT") {
        const body = await readObject(request, maxBodyBytes);
        assertOnlyKeys(body, ["content", "expectedRevision"]);
        await dependencies.settings.updateProfileSoul(
          profile,
          requiredString(body.content, "content", 256 * 1024, true),
          requiredRevision(body.expectedRevision),
        );
        return { ...ok(await dependencies.settings.getProfileSoul(profile)), changed: { kind: "soul", profile } };
      }
      return methodNotAllowed("GET, PUT");
    }

    if (resource === "memory") {
      if (segments.length === 5) {
        if (request.method !== "GET") return methodNotAllowed("GET");
        return ok(await dependencies.settings.getMemoryStatus(profile));
      }
      if (segments.length === 6 && segments[5] === "provider") {
        if (request.method !== "PUT") return methodNotAllowed("PUT");
        const body = await readObject(request, maxBodyBytes);
        assertOnlyKeys(body, ["provider", "expectedProvider"]);
        const provider = requiredString(body.provider, "provider", 64, true);
        await dependencies.settings.setMemoryProvider(profile, provider, requiredString(body.expectedProvider, "expectedProvider", 64, true));
        return { ...ok(await dependencies.settings.getMemoryStatus(profile)), changed: { kind: "memory", profile } };
      }
      if (segments.length === 7 && segments[5] === "providers") {
        const provider = segments[6]!;
        if (request.method === "GET") return ok(await dependencies.settings.getMemoryProviderConfig(profile, provider));
        if (request.method === "PATCH") {
          const body = await readObject(request, maxBodyBytes);
          assertOnlyKeys(body, ["values", "expectedRevision"]);
          await dependencies.settings.updateMemoryProviderConfig(
            profile,
            provider,
            requiredSettingsValues(body.values),
            requiredRevision(body.expectedRevision),
          );
          return { ...ok(await dependencies.settings.getMemoryProviderConfig(profile, provider)), changed: { kind: "memory", profile, id: provider } };
        }
        return methodNotAllowed("GET, PATCH");
      }
      // Raw memory editing, reset, and secret provider fields are deliberately
      // absent from the remote-safe Office contract.
      return notFound();
    }

    return notFound();
  } catch (error) {
    if (error instanceof HttpInputError) return { status: error.status, body: { error: { code: error.code, message: error.message } } };
    if (error instanceof HermesSettingsError) return settingsError(error);
    return { status: 502, body: { error: { code: "runtime_unavailable", message: "Hermes settings are unavailable." } } };
  }
}

async function readObject(request: IncomingMessage, maxBytes: number): Promise<Record<string, unknown>> {
  if (!/^application\/json(?:\s*;|$)/i.test(String(request.headers["content-type"] ?? ""))) throw new HttpInputError(415, "unsupported_media_type", "Content-Type must be application/json.");
  const declared = Number(request.headers["content-length"]);
  if (Number.isFinite(declared) && declared > maxBytes) { request.resume(); throw new HttpInputError(413, "body_too_large", "Request body is too large."); }
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += bytes.byteLength;
    if (size > maxBytes) throw new HttpInputError(413, "body_too_large", "Request body is too large.");
    chunks.push(bytes);
  }
  let value: unknown;
  try { value = JSON.parse(Buffer.concat(chunks).toString("utf8")); } catch { throw new HttpInputError(400, "invalid_json", "Request body must be valid JSON."); }
  if (!isRecord(value)) throw new HttpInputError(400, "invalid_body", "Request body must be an object.");
  return value;
}

function decodeSegments(pathname: string): string[] {
  try { return pathname.split("/").filter(Boolean).map((segment) => decodeURIComponent(segment)); }
  catch { throw new HttpInputError(400, "invalid_path", "Request path is invalid."); }
}

function assertOnlyKeys(value: Record<string, unknown>, allowedKeys: readonly string[]): void {
  const allowed = new Set(allowedKeys);
  if (Object.keys(value).some((key) => !allowed.has(key))) throw new HttpInputError(400, "invalid_body", "Request contains unsupported fields.");
}

function requiredBoolean(value: unknown, name: string): boolean { if (typeof value !== "boolean") throw fieldError(name); return value; }
function requiredInteger(value: unknown, name: string, min: number): number { if (typeof value !== "number" || !Number.isInteger(value) || value < min) throw fieldError(name); return value; }
function requiredString(value: unknown, name: string, maxBytes: number, allowEmpty = false): string { if (typeof value !== "string" || (!allowEmpty && value.trim() === "") || value.includes("\0") || Buffer.byteLength(value) > maxBytes) throw fieldError(name); return value; }
function requiredGlobalContext(value: unknown): string { if (typeof value !== "string" || !isGlobalContextWithinBudget(value)) throw fieldError("context"); return value; }
function requiredRevision(value: unknown): string { if (typeof value !== "string" || !/^[A-Za-z0-9_-]{43}$/.test(value)) throw fieldError("expectedRevision"); return value; }
function requiredStringArray(value: unknown, name: string, maxItems: number): string[] { if (!Array.isArray(value) || value.length > maxItems || !value.every((item) => typeof item === "string")) throw fieldError(name); return [...value] as string[]; }
function requiredSettingsValues(value: unknown): Record<string, boolean | string> { if (!isRecord(value) || Object.keys(value).length > 100) throw fieldError("values"); const result: Record<string, boolean | string> = {}; for (const [key, item] of Object.entries(value)) { if (typeof item !== "boolean" && typeof item !== "string") throw fieldError(`values.${key}`); result[key] = item; } return result; }
function fieldError(name: string): HttpInputError { return new HttpInputError(400, "invalid_body", `${name} is invalid.`); }
function ok(body: unknown): SettingsHttpResult { return { status: 200, body }; }
function notFound(): SettingsHttpResult { return { status: 404, body: { error: { code: "not_found", message: "Settings route was not found." } } }; }
function methodNotAllowed(allow: string): SettingsHttpResult { return { status: 405, body: { error: { code: "method_not_allowed", message: "Method is not allowed." } }, headers: { Allow: allow } }; }
function settingsError(error: HermesSettingsError): SettingsHttpResult { const status = error.code === "conflict" ? 409 : error.code === "invalid_request" ? 400 : error.code === "not_found" ? 404 : error.code === "timed_out" ? 504 : 502; const code = error.code === "rejected" ? "runtime_unavailable" : error.code; return { status, body: { error: { code, message: error.message } } }; }
function isRecord(value: unknown): value is Record<string, unknown> { return typeof value === "object" && value !== null && !Array.isArray(value); }

class HttpInputError extends Error {
  constructor(readonly status: number, readonly code: string, message: string) { super(message); }
}
