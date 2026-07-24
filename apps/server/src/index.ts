import { createOfficeServer } from "./server.js";
import { HermesBackend } from "./hermes-backend.js";
import { OfficeTeamsStore } from "./office-teams.js";
import { brandEnv, brandEnvIsTrue, brandStatePath } from "./brand-env.js";
import { HermesAgentUpdateManager } from "./hermes-agent-update.js";

const host = brandEnv("HOST") ?? "127.0.0.1";
const configuredPort = Number.parseInt(brandEnv("PORT") ?? "4317", 10);
const port = Number.isSafeInteger(configuredPort) && configuredPort >= 0 ? configuredPort : 4317;
const configuredOrigins = brandEnv("ALLOWED_ORIGINS")
  ?.split(",")
  .map((origin) => origin.trim())
  .filter((origin) => origin.length > 0);
const desktopOrigins = brandEnv("DESKTOP_ORIGINS")
  ?.split(",")
  .map((origin) => origin.trim())
  .filter((origin) => origin.length > 0);
const parsedTrustedProxyHops = Number.parseInt(brandEnv("TRUSTED_PROXY_HOPS") ?? "0", 10);
const trustedProxyHops = Number.isInteger(parsedTrustedProxyHops) && parsedTrustedProxyHops >= 0 && parsedTrustedProxyHops <= 8
  ? parsedTrustedProxyHops
  : 0;

const teamsPath = brandEnv("TEAMS_PATH") ?? brandStatePath("teams.json");
const teamsStore = new OfficeTeamsStore(teamsPath);
const listTeamLayers = async () => await teamsStore.listSkillLayers();
const hermesExecutable = brandEnv("HERMES_EXECUTABLE") ?? "hermes";
const hermesAgentUpdate = new HermesAgentUpdateManager(hermesExecutable);

const hermesMode = brandEnv("HERMES_MODE") ?? "managed";
const hermesToken = brandEnv("HERMES_TOKEN");
const runtimeSource = hermesMode === "demo"
  ? undefined
  : hermesMode === "existing"
    ? new HermesBackend({
        baseUrl: brandEnv("HERMES_URL") ?? "",
        ...(hermesToken === undefined ? {} : { sessionToken: hermesToken }),
        listTeamLayers,
      })
    : new HermesBackend({
        executable: hermesExecutable,
        listTeamLayers,
      });

let shuttingDown = false;
let server: ReturnType<typeof createOfficeServer> | undefined;
let initialization: Promise<void> | undefined;
let shutdownFlight: Promise<void> | undefined;

function shutdown(): Promise<void> {
  if (shutdownFlight !== undefined) return shutdownFlight;
  shuttingDown = true;
  const flight = (async () => {
    await runtimeSource?.close();
    await initialization?.catch(() => undefined);
    await server?.close();
  })();
  shutdownFlight = flight;
  return flight;
}

// Install handlers before the first asynchronous initialization boundary so a
// partially-started managed Hermes child always reaches the shared cleanup path.
process.once("SIGINT", () => {
  void shutdown().finally(() => process.exit(0));
});
process.once("SIGTERM", () => {
  void shutdown().finally(() => process.exit(0));
});

initialization = (async () => {
  try {
    if (runtimeSource !== undefined) await runtimeSource.start();
    if (shuttingDown) return;

    const remoteToken = brandEnv("REMOTE_TOKEN");
    const desktopCapability = brandEnv("DESKTOP_CAPABILITY");
    const webRoot = brandEnv("WEB_ROOT");
    const candidate = createOfficeServer({
      host,
      port,
      ...(configuredOrigins === undefined ? {} : { allowedOrigins: configuredOrigins }),
      allowNonLoopback: brandEnvIsTrue("ALLOW_NON_LOOPBACK"),
      trustedProxyHops,
      deviceRegistryPath: brandEnv("DEVICE_REGISTRY_PATH") ?? brandStatePath("devices.json"),
      tokenUsagePath: brandEnv("TOKEN_USAGE_PATH") ?? brandStatePath("token-usage.json"),
      teamsPath,
      teamsStore,
      ...(remoteToken === undefined ? {} : { remoteToken }),
      ...(desktopCapability === undefined ? {} : { desktopCapability }),
      ...(desktopOrigins === undefined ? {} : { desktopOrigins }),
      ...(webRoot === undefined ? {} : { staticWebRoot: webRoot }),
      // Fail closed unless the Tailscale launcher (or operator) sets this explicitly.
      // Accepts HERMES_STUDIO_REMOTE_PRIVILEGED or deprecated HERMES_OFFICE_REMOTE_PRIVILEGED.
      remotePrivilegedEnabled: brandEnvIsTrue("REMOTE_PRIVILEGED"),
      ...(runtimeSource === undefined ? {} : { runtimeSource }),
      hermesAgentUpdate,
    });
    const address = await candidate.listen();
    if (shuttingDown) { await candidate.close(); return; }
    server = candidate;
    process.stdout.write(`Hermes Studio Server listening on http://${address.address}:${address.port}\n`);
  } catch (error) {
    await runtimeSource?.close().catch(() => undefined);
    throw error;
  }
})();
await initialization;

export { createOfficeServer } from "./server.js";
export { HermesBackend } from "./hermes-backend.js";
export { discoverHermesRuntime } from "./hermes-runtime.js";
