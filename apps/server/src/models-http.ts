import type { IncomingMessage } from "node:http";
import type { ProtocolError } from "@hermes-studio/protocol";
import {
  HermesModelsError,
  type HermesModelsAdapter,
  type LiveModelsCatalog,
} from "./hermes-models.js";
import { HermesSettingsError } from "./hermes-settings.js";

export const OFFICE_MODELS_PATH = "/api/v1/models";

const NO_STORE_HEADERS = { "Cache-Control": "no-store" } as const;

export type ModelsHttpResult = { status: number; body: unknown; headers?: Record<string, string> };

export function isModelsHttpPath(pathname: string): boolean {
  return pathname === OFFICE_MODELS_PATH;
}

/**
 * GET /api/v1/models?profile=&provider=
 * state-read live catalog: providers list + models for selected (or active) provider.
 */
export async function routeModelsHttp(
  request: IncomingMessage,
  requestUrl: URL,
  adapter: HermesModelsAdapter | undefined,
): Promise<ModelsHttpResult> {
  if (request.method !== "GET") {
    return {
      status: 405,
      body: failureBody("bad_request", "Method is not allowed."),
      headers: { Allow: "GET", ...NO_STORE_HEADERS },
    };
  }

  const allowed = new Set(["profile", "provider", "fresh"]);
  if (
    [...requestUrl.searchParams.keys()].some((key) => !allowed.has(key))
    || requestUrl.searchParams.getAll("profile").length !== 1
    || requestUrl.searchParams.getAll("provider").length > 1
    || requestUrl.searchParams.getAll("fresh").length > 1
  ) {
    return { status: 400, body: failureBody("bad_request", "Model catalog query is invalid."), headers: { ...NO_STORE_HEADERS } };
  }

  const profile = requestUrl.searchParams.get("profile");
  if (profile === null || profile === "" || profile.length > 64) {
    return { status: 400, body: failureBody("bad_request", "Profile name is invalid."), headers: { ...NO_STORE_HEADERS } };
  }

  const providerParam = requestUrl.searchParams.get("provider");
  if (providerParam !== null && (providerParam === "" || providerParam.length > 128)) {
    return { status: 400, body: failureBody("bad_request", "Provider name is invalid."), headers: { ...NO_STORE_HEADERS } };
  }

  const freshParam = requestUrl.searchParams.get("fresh");
  if (freshParam !== null && freshParam !== "1" && freshParam !== "true") {
    return { status: 400, body: failureBody("bad_request", "Model catalog query is invalid."), headers: { ...NO_STORE_HEADERS } };
  }
  const forceRefresh = freshParam === "1" || freshParam === "true";

  if (adapter === undefined) {
    return {
      status: 503,
      body: failureBody("runtime_unavailable", "Hermes model catalog is unavailable."),
      headers: { ...NO_STORE_HEADERS },
    };
  }

  try {
    const catalog = await adapter.loadLiveCatalog(
      profile,
      providerParam === null ? undefined : providerParam,
      { forceRefresh },
    );
    return { status: 200, body: publicCatalog(catalog), headers: { ...NO_STORE_HEADERS } };
  } catch (error) {
    if (error instanceof HermesModelsError) return modelsError(error);
    if (error instanceof HermesSettingsError) return settingsAsModelsError(error);
    if (error instanceof Error && /profile name is invalid/i.test(error.message)) {
      return { status: 400, body: failureBody("bad_request", "Profile name is invalid."), headers: { ...NO_STORE_HEADERS } };
    }
    return {
      status: 502,
      body: failureBody("runtime_unavailable", "Hermes model catalog is unavailable."),
      headers: { ...NO_STORE_HEADERS },
    };
  }
}

function publicCatalog(catalog: LiveModelsCatalog): LiveModelsCatalog {
  return {
    profile: catalog.profile,
    providers: catalog.providers.map((item) => ({
      id: item.id,
      label: item.label,
      active: item.active === true,
    })),
    provider: catalog.provider,
    models: catalog.models.map((model) => ({
      id: model.id,
      label: model.label,
      ...(model.reasoningEfforts === undefined || model.reasoningEfforts.length === 0
        ? {}
        : { reasoningEfforts: [...model.reasoningEfforts] }),
    })),
    refreshedAt: catalog.refreshedAt,
  };
}

function modelsError(error: HermesModelsError): ModelsHttpResult {
  if (error.code === "invalid_request") {
    return { status: 400, body: failureBody("bad_request", "Model catalog request is invalid."), headers: { ...NO_STORE_HEADERS } };
  }
  if (error.code === "not_found") {
    return { status: 404, body: failureBody("not_found", "Hermes model catalog was not found."), headers: { ...NO_STORE_HEADERS } };
  }
  if (error.code === "timed_out") {
    return { status: 504, body: failureBody("runtime_unavailable", "Hermes model catalog timed out."), headers: { ...NO_STORE_HEADERS } };
  }
  return {
    status: 502,
    body: failureBody("runtime_unavailable", "Hermes model catalog is unavailable."),
    headers: { ...NO_STORE_HEADERS },
  };
}

function settingsAsModelsError(error: HermesSettingsError): ModelsHttpResult {
  if (error.code === "invalid_request") {
    return { status: 400, body: failureBody("bad_request", "Profile name is invalid."), headers: { ...NO_STORE_HEADERS } };
  }
  if (error.code === "not_found") {
    return { status: 404, body: failureBody("not_found", "Hermes profile was not found."), headers: { ...NO_STORE_HEADERS } };
  }
  if (error.code === "timed_out") {
    return { status: 504, body: failureBody("runtime_unavailable", "Hermes model catalog timed out."), headers: { ...NO_STORE_HEADERS } };
  }
  return {
    status: 502,
    body: failureBody("runtime_unavailable", "Hermes model catalog is unavailable."),
    headers: { ...NO_STORE_HEADERS },
  };
}

function failureBody(code: ProtocolError["code"], message: string): ProtocolError {
  return { code, message, retryable: false };
}
