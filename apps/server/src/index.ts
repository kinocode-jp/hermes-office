import { createOfficeServer } from "./server.js";
import { HermesBackend } from "./hermes-backend.js";
import { homedir } from "node:os";
import { join } from "node:path";

const host = process.env.HERMES_OFFICE_HOST ?? "127.0.0.1";
const configuredPort = Number.parseInt(process.env.HERMES_OFFICE_PORT ?? "4317", 10);
const port = Number.isSafeInteger(configuredPort) && configuredPort >= 0 ? configuredPort : 4317;
const configuredOrigins = process.env.HERMES_OFFICE_ALLOWED_ORIGINS
  ?.split(",")
  .map((origin) => origin.trim())
  .filter((origin) => origin.length > 0);
const desktopOrigins = process.env.HERMES_OFFICE_DESKTOP_ORIGINS
  ?.split(",")
  .map((origin) => origin.trim())
  .filter((origin) => origin.length > 0);
const parsedTrustedProxyHops = Number.parseInt(process.env.HERMES_OFFICE_TRUSTED_PROXY_HOPS ?? "0", 10);
const trustedProxyHops = Number.isInteger(parsedTrustedProxyHops) && parsedTrustedProxyHops >= 0 && parsedTrustedProxyHops <= 8
  ? parsedTrustedProxyHops
  : 0;

const hermesMode = process.env.HERMES_OFFICE_HERMES_MODE ?? "managed";
const runtimeSource = hermesMode === "demo"
  ? undefined
  : hermesMode === "existing"
    ? new HermesBackend({
        baseUrl: process.env.HERMES_OFFICE_HERMES_URL ?? "",
        ...(process.env.HERMES_OFFICE_HERMES_TOKEN === undefined ? {} : { sessionToken: process.env.HERMES_OFFICE_HERMES_TOKEN }),
      })
    : new HermesBackend({ executable: process.env.HERMES_OFFICE_HERMES_EXECUTABLE ?? "hermes" });

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

    const candidate = createOfficeServer({
      host,
      port,
      ...(configuredOrigins === undefined ? {} : { allowedOrigins: configuredOrigins }),
      allowNonLoopback: process.env.HERMES_OFFICE_ALLOW_NON_LOOPBACK === "true",
      trustedProxyHops,
      deviceRegistryPath: process.env.HERMES_OFFICE_DEVICE_REGISTRY_PATH ?? join(homedir(), ".hermes-office", "devices.json"),
      ...(process.env.HERMES_OFFICE_REMOTE_TOKEN === undefined ? {} : { remoteToken: process.env.HERMES_OFFICE_REMOTE_TOKEN }),
      ...(process.env.HERMES_OFFICE_DESKTOP_CAPABILITY === undefined ? {} : { desktopCapability: process.env.HERMES_OFFICE_DESKTOP_CAPABILITY }),
      ...(desktopOrigins === undefined ? {} : { desktopOrigins }),
      ...(process.env.HERMES_OFFICE_WEB_ROOT === undefined ? {} : { staticWebRoot: process.env.HERMES_OFFICE_WEB_ROOT }),
      ...(runtimeSource === undefined ? {} : { runtimeSource }),
    });
    const address = await candidate.listen();
    if (shuttingDown) { await candidate.close(); return; }
    server = candidate;
    process.stdout.write(`Hermes Office Server listening on http://${address.address}:${address.port}\n`);
  } catch (error) {
    await runtimeSource?.close().catch(() => undefined);
    throw error;
  }
})();
await initialization;

export { createOfficeServer } from "./server.js";
export { HermesBackend } from "./hermes-backend.js";
export { discoverHermesRuntime } from "./hermes-runtime.js";
