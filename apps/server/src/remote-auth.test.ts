import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { WebSocket } from "ws";
import { createOfficeServer } from "./server.js";

const LOCAL_ORIGIN = "http://localhost:4173";
const REMOTE_ORIGIN = "https://office.tailnet.example";
const REMOTE_TOKEN = "correct-horse-battery-staple-remote-token";

async function deviceLogin(
  base: string,
  token: string,
  deviceName = "Travel phone",
): Promise<Response> {
  return await fetch(`${base}/api/v1/auth/device`, {
    method: "POST",
    headers: {
      Origin: REMOTE_ORIGIN,
      "Content-Type": "application/json",
      "X-Forwarded-Proto": "https",
      "X-Forwarded-For": "100.64.0.10",
    },
    body: JSON.stringify({ token, deviceName }),
  });
}

function responseCookies(response: Response): string {
  const raw = response.headers.get("set-cookie") ?? "";
  return [...raw.matchAll(/(?:^|,\s*)(hermes_office_(?:device|session))=([^;,\s]+)/g)]
    .map((match) => `${match[1]}=${match[2]}`)
    .join("; ");
}

test("remote origins cannot claim local bootstrap even through a loopback proxy", async () => {
  const server = createOfficeServer({
    port: 0,
    allowedOrigins: [LOCAL_ORIGIN, REMOTE_ORIGIN],
  });
  const address = await server.listen();
  const base = `http://127.0.0.1:${address.port}`;
  try {
    const remote = await fetch(`${base}/api/v1/auth/local`, {
      method: "POST",
      headers: { Origin: REMOTE_ORIGIN },
    });
    assert.equal(remote.status, 403);

    const proxiedSpoof = await fetch(`${base}/api/v1/auth/local`, {
      method: "POST",
      headers: {
        Origin: LOCAL_ORIGIN,
        Host: "office.tailnet.example",
        "X-Forwarded-For": "100.64.0.10",
      },
    });
    assert.equal(proxiedSpoof.status, 403);

    const local = await fetch(`${base}/api/v1/auth/local`, {
      method: "POST",
      headers: { Origin: LOCAL_ORIGIN },
    });
    assert.equal(local.status, 200);
  } finally {
    await server.close();
  }
});

test("one-time enrollment creates a revocable remote operator device without exposing credentials", async () => {
  const server = createOfficeServer({
    port: 0,
    allowedOrigins: [LOCAL_ORIGIN, REMOTE_ORIGIN],
    remoteToken: REMOTE_TOKEN,
    trustedProxyHops: 1,
  });
  const address = await server.listen();
  const base = `http://127.0.0.1:${address.port}`;
  try {
    const insecure = await fetch(`${base}/api/v1/auth/device`, {
      method: "POST",
      headers: { Origin: REMOTE_ORIGIN, "Content-Type": "application/json" },
      body: JSON.stringify({ token: REMOTE_TOKEN, deviceName: "Plaintext phone" }),
    });
    assert.equal(insecure.status, 403);

    const login = await deviceLogin(base, REMOTE_TOKEN);
    assert.equal(login.status, 200);
    const loginText = await login.text();
    assert.equal(loginText.includes(REMOTE_TOKEN), false);
    const session = JSON.parse(loginText) as {
      csrfToken: string;
      principal: { id: string; local: boolean; deviceName: string; tier: string };
    };
    assert.deepEqual(session.principal, {
      id: session.principal.id,
      local: false,
      deviceName: "Travel phone",
      tier: "operator",
    });
    const setCookie = login.headers.get("set-cookie") ?? "";
    assert.match(setCookie, /HttpOnly/i);
    assert.match(setCookie, /Secure/i);
    assert.match(setCookie, /SameSite=Strict/i);
    const cookie = responseCookies(login);
    assert.match(cookie, /hermes_office_session=/);
    assert.match(cookie, /hermes_office_device=/);

    const audit = await fetch(`${base}/api/v1/audit`, {
      headers: { Origin: REMOTE_ORIGIN, Cookie: cookie },
    });
    assert.equal(audit.status, 403);
    const snapshot = await fetch(`${base}/api/v1/snapshot`, {
      headers: { Origin: REMOTE_ORIGIN, Cookie: cookie },
    });
    assert.equal(snapshot.status, 200);
    const access = (await snapshot.json() as {
      capabilities: { access: { deviceId: string; tier: string; exposure: string; authentication: string; allowedOperations: string[] } };
    }).capabilities.access;
    assert.deepEqual({ deviceId: access.deviceId, tier: access.tier, exposure: access.exposure, authentication: access.authentication }, {
      deviceId: session.principal.id,
      tier: "operator",
      exposure: "tailnet",
      authentication: "device-cookie",
    });
    assert.equal(access.allowedOperations.includes("chat.session.create"), true);
    assert.equal(access.allowedOperations.includes("global-settings.update"), false);

    assert.equal((await fetch(`${base}/api/v1/auth/logout`, {
      method: "POST",
      headers: { Origin: REMOTE_ORIGIN, Cookie: cookie },
    })).status, 403);
    assert.equal((await fetch(`${base}/api/v1/auth/logout`, {
      method: "POST",
      headers: { Origin: REMOTE_ORIGIN, Cookie: cookie, "Content-Type": "application/json", "X-CSRF-Token": session.csrfToken },
      body: "{}",
    })).status, 413);
    assert.equal((await fetch(`${base}/api/v1/audit`, {
      method: "POST",
      headers: { Origin: REMOTE_ORIGIN, Cookie: cookie },
    })).status, 405);

    const events = new WebSocket(`${base.replace("http:", "ws:")}/api/v1/events`, {
      headers: { Origin: REMOTE_ORIGIN, Cookie: cookie },
    });
    const remoteRuntime = waitForTopic(events, "runtime.status");
    await once(events, "open");
    await remoteRuntime;
    const operatorAuditLeak = expectNoTopic(events, "access.changed", 100);
    const localLogin = await fetch(`${base}/api/v1/auth/local`, { method: "POST", headers: { Origin: LOCAL_ORIGIN } });
    assert.equal(localLogin.status, 200);
    assert.equal(await operatorAuditLeak, true);

    const localCookie = (localLogin.headers.get("set-cookie") ?? "").split(";", 1)[0]!;
    const ownerEvents = new WebSocket(`${base.replace("http:", "ws:")}/api/v1/events`, {
      headers: { Origin: LOCAL_ORIGIN, Cookie: localCookie },
    });
    const ownerRuntime = waitForTopic(ownerEvents, "runtime.status");
    await once(ownerEvents, "open");
    await ownerRuntime;
    const ownerAudit = waitForTopic(ownerEvents, "access.changed");
    assert.equal((await fetch(`${base}/api/v1/auth/local`, { method: "POST", headers: { Origin: LOCAL_ORIGIN } })).status, 200);
    await ownerAudit;
    ownerEvents.close();
    const closed = once(events, "close");

    const logout = await fetch(`${base}/api/v1/auth/logout`, {
      method: "POST",
      headers: { Origin: REMOTE_ORIGIN, Cookie: cookie, "X-CSRF-Token": session.csrfToken },
    });
    assert.equal(logout.status, 200);
    const logoutCookies = logout.headers.get("set-cookie") ?? "";
    assert.match(logoutCookies, /hermes_office_session=;[^,]*Path=\/;[^,]*Max-Age=0/i);
    assert.match(logoutCookies, /hermes_office_device=;[^,]*Path=\/api\/v1\/auth\/device;[^,]*Max-Age=0/i);
    await closed;
    assert.equal((await fetch(`${base}/api/v1/audit`, { headers: { Origin: REMOTE_ORIGIN, Cookie: cookie } })).status, 401);
    assert.equal((await fetch(`${base}/api/v1/auth/logout`, {
      method: "POST",
      headers: { Origin: REMOTE_ORIGIN, Cookie: cookie, "X-CSRF-Token": session.csrfToken },
    })).status, 401);

    const renewal = await fetch(`${base}/api/v1/auth/device/renew`, {
      method: "POST",
      headers: { Origin: REMOTE_ORIGIN, Cookie: cookie, "X-Forwarded-Proto": "https" },
    });
    assert.equal(renewal.status, 401);

    const nextLogin = await deviceLogin(base, REMOTE_TOKEN, "Owner phone");
    assert.equal(nextLogin.status, 409);
  } finally {
    await server.close();
  }
});

async function waitForTopic(websocket: WebSocket, topic: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => { cleanup(); reject(new Error(`WebSocket topic ${topic} timed out.`)); }, 2_000);
    const onMessage = (data: WebSocket.RawData): void => {
      try {
        const value = JSON.parse(data.toString()) as { topic?: unknown };
        if (value.topic === topic) { cleanup(); resolve(); }
      } catch { /* Ignore unrelated malformed test frames. */ }
    };
    const cleanup = (): void => { clearTimeout(timer); websocket.off("message", onMessage); };
    websocket.on("message", onMessage);
  });
}

async function expectNoTopic(websocket: WebSocket, topic: string, durationMs: number): Promise<boolean> {
  return await new Promise<boolean>((resolve) => {
    const onMessage = (data: WebSocket.RawData): void => {
      try {
        const value = JSON.parse(data.toString()) as { topic?: unknown };
        if (value.topic === topic) { cleanup(); resolve(false); }
      } catch { /* Ignore unrelated malformed test frames. */ }
    };
    const timer = setTimeout(() => { cleanup(); resolve(true); }, durationMs);
    const cleanup = (): void => { clearTimeout(timer); websocket.off("message", onMessage); };
    websocket.on("message", onMessage);
  });
}

test("device authentication is disabled by default, bounded, strict, and rate limited", async () => {
  const disabledServer = createOfficeServer({ port: 0, allowedOrigins: [REMOTE_ORIGIN] });
  const disabledAddress = await disabledServer.listen();
  const disabledBase = `http://127.0.0.1:${disabledAddress.port}`;
  try {
    assert.equal((await deviceLogin(disabledBase, REMOTE_TOKEN)).status, 404);
  } finally {
    await disabledServer.close();
  }

  const server = createOfficeServer({
    port: 0,
    allowedOrigins: [REMOTE_ORIGIN],
    remoteToken: REMOTE_TOKEN,
    trustedProxyHops: 1,
    maxJsonBytes: 4 * 1024,
  });
  const address = await server.listen();
  const base = `http://127.0.0.1:${address.port}`;
  try {
    const unknownField = await fetch(`${base}/api/v1/auth/device`, {
      method: "POST",
      headers: { Origin: REMOTE_ORIGIN, "Content-Type": "application/json", "X-Forwarded-Proto": "https", "X-Forwarded-For": "100.64.0.10" },
      body: JSON.stringify({ token: REMOTE_TOKEN, deviceName: "Phone", extra: true }),
    });
    assert.equal(unknownField.status, 400);

    const oversized = await fetch(`${base}/api/v1/auth/device`, {
      method: "POST",
      headers: { Origin: REMOTE_ORIGIN, "Content-Type": "application/json", "X-Forwarded-Proto": "https", "X-Forwarded-For": "100.64.0.10" },
      body: JSON.stringify({ token: "x".repeat(5_000), deviceName: "Phone" }),
    });
    assert.equal(oversized.status, 413);

    for (let attempt = 0; attempt < 5; attempt += 1) {
      const rejected = await deviceLogin(base, `wrong-${"x".repeat(32)}-${attempt}`);
      assert.equal(rejected.status, 401);
      assert.equal((await rejected.text()).includes(`wrong-`), false);
    }
    const limited = await deviceLogin(base, `wrong-${"y".repeat(32)}`);
    assert.equal(limited.status, 429);
    assert.equal(limited.headers.get("retry-after"), "60");
  } finally {
    await server.close();
  }
});

test("device registry survives restart and token rotation replaces its generation", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "hermes-office-devices-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const deviceRegistryPath = join(directory, "devices.json");
  const options = {
    port: 0,
    allowedOrigins: [REMOTE_ORIGIN],
    remoteToken: REMOTE_TOKEN,
    trustedProxyHops: 1,
    deviceRegistryPath,
  } as const;
  const first = createOfficeServer(options);
  const firstAddress = await first.listen();
  const firstLogin = await deviceLogin(`http://127.0.0.1:${firstAddress.port}`, REMOTE_TOKEN);
  assert.equal(firstLogin.status, 200);
  const firstCookies = responseCookies(firstLogin);
  await first.close();

  const second = createOfficeServer(options);
  const secondAddress = await second.listen();
  const secondBase = `http://127.0.0.1:${secondAddress.port}`;
  assert.equal((await deviceLogin(secondBase, REMOTE_TOKEN, "Second phone")).status, 409);
  assert.equal((await fetch(`${secondBase}/api/v1/auth/device/renew`, {
    method: "POST",
    headers: { Origin: REMOTE_ORIGIN, Cookie: firstCookies, "X-Forwarded-Proto": "https" },
  })).status, 200);
  await second.close();

  const rotatedToken = "replacement-enrollment-token-with-32-characters";
  const rotated = createOfficeServer({ ...options, remoteToken: rotatedToken });
  const rotatedAddress = await rotated.listen();
  const rotatedBase = `http://127.0.0.1:${rotatedAddress.port}`;
  try {
    assert.equal((await fetch(`${rotatedBase}/api/v1/auth/device/renew`, {
      method: "POST",
      headers: { Origin: REMOTE_ORIGIN, Cookie: firstCookies, "X-Forwarded-Proto": "https" },
    })).status, 401);
    assert.equal((await deviceLogin(rotatedBase, rotatedToken, "Replacement phone")).status, 200);
  } finally { await rotated.close(); }
});

test("malformed device registry fails closed without reopening enrollment", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "hermes-office-devices-corrupt-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const deviceRegistryPath = join(directory, "devices.json");
  await writeFile(deviceRegistryPath, "{not-json", { mode: 0o600 });
  const server = createOfficeServer({
    port: 0,
    allowedOrigins: [REMOTE_ORIGIN],
    remoteToken: REMOTE_TOKEN,
    trustedProxyHops: 1,
    deviceRegistryPath,
  });
  const address = await server.listen();
  try {
    assert.equal((await deviceLogin(`http://127.0.0.1:${address.port}`, REMOTE_TOKEN)).status, 409);
  } finally { await server.close(); }
});
