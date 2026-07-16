import { createOfficeServer } from "./server.js";
import { HermesBackend } from "./hermes-backend.js";

const host = process.env.HERMES_OFFICE_HOST ?? "127.0.0.1";
const configuredPort = Number.parseInt(process.env.HERMES_OFFICE_PORT ?? "4317", 10);
const port = Number.isSafeInteger(configuredPort) && configuredPort >= 0 ? configuredPort : 4317;
const configuredOrigins = process.env.HERMES_OFFICE_ALLOWED_ORIGINS
  ?.split(",")
  .map((origin) => origin.trim())
  .filter((origin) => origin.length > 0);

const hermesMode = process.env.HERMES_OFFICE_HERMES_MODE ?? "managed";
const runtimeSource = hermesMode === "demo"
  ? undefined
  : hermesMode === "existing"
    ? new HermesBackend({
        baseUrl: process.env.HERMES_OFFICE_HERMES_URL ?? "",
        ...(process.env.HERMES_OFFICE_HERMES_TOKEN === undefined ? {} : { sessionToken: process.env.HERMES_OFFICE_HERMES_TOKEN }),
      })
    : new HermesBackend({ executable: process.env.HERMES_OFFICE_HERMES_EXECUTABLE ?? "hermes" });
if (runtimeSource !== undefined) await runtimeSource.start();

const server = createOfficeServer({
  host,
  port,
  ...(configuredOrigins === undefined ? {} : { allowedOrigins: configuredOrigins }),
  allowNonLoopback: process.env.HERMES_OFFICE_ALLOW_NON_LOOPBACK === "true",
  ...(process.env.HERMES_OFFICE_REMOTE_TOKEN === undefined ? {} : { remoteToken: process.env.HERMES_OFFICE_REMOTE_TOKEN }),
  ...(process.env.HERMES_OFFICE_WEB_ROOT === undefined ? {} : { staticWebRoot: process.env.HERMES_OFFICE_WEB_ROOT }),
  ...(runtimeSource === undefined ? {} : { runtimeSource }),
});

const address = await server.listen();
process.stdout.write(`Hermes Office Server listening on http://${address.address}:${address.port}\n`);

let shuttingDown = false;
async function shutdown(): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  await server.close();
}

process.once("SIGINT", () => {
  void shutdown().finally(() => process.exit(0));
});
process.once("SIGTERM", () => {
  void shutdown().finally(() => process.exit(0));
});

export { createOfficeServer } from "./server.js";
export { HermesBackend } from "./hermes-backend.js";
export { discoverHermesRuntime } from "./hermes-runtime.js";
