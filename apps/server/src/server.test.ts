import assert from "node:assert/strict";
import test from "node:test";
import { WebSocket } from "ws";
import { createOfficeServer, isLoopbackHost, makeOriginAllowlist } from "./server.js";

test("direct non-loopback listeners are always refused", () => {
  assert.throws(() => createOfficeServer({ host: "0.0.0.0" }), /direct non-loopback bind/);
  assert.throws(
    () => createOfficeServer({ host: "0.0.0.0", allowNonLoopback: true }),
    /trusted HTTPS reverse proxy/,
  );
  assert.throws(() =>
    createOfficeServer({
      host: "0.0.0.0",
      allowNonLoopback: true,
      remoteToken: "r".repeat(32),
    }),
    /trusted HTTPS reverse proxy/,
  );
  assert.equal(isLoopbackHost("::1"), true);
  assert.equal(isLoopbackHost("192.168.1.20"), false);
});

test("origin allowlist rejects wildcards and null origins", () => {
  assert.throws(() => makeOriginAllowlist(["*"]), /explicit, non-null/);
  assert.throws(() => makeOriginAllowlist(["null"]), /explicit, non-null/);
  assert.equal(
    makeOriginAllowlist(["https://office.example/"]).has("https://office.example"),
    true,
  );
});

test("snapshot is bounded, explicit, and does not expose secret-shaped fields", async () => {
  const server = createOfficeServer({ port: 0 });
  const address = await server.listen();

  try {
    const base = `http://127.0.0.1:${address.port}`;
    const bootstrap = await fetch(`${base}/api/v1/auth/local`, {
      method: "POST",
      headers: { Origin: base },
    });
    assert.equal(bootstrap.status, 200);
    const cookie = bootstrap.headers.get("set-cookie") ?? "";
    const response = await fetch(`${base}/api/v1/snapshot`, {
      headers: { Origin: base, Cookie: cookie },
    });
    assert.equal(response.status, 200);
    const body = await response.text();
    assert.equal(/password|api[_-]?key|access[_-]?token|refresh[_-]?token/i.test(body), false);
    assert.equal(response.headers.get("cache-control"), "no-store");
    const access = (JSON.parse(body) as { capabilities: { access: { deviceId: string; tier: string; exposure: string; authentication: string } } }).capabilities.access;
    assert.deepEqual(access, {
      deviceId: "local-browser",
      tier: "owner",
      exposure: "loopback",
      authentication: "local-cookie",
      allowedOperations: [
        "state.read", "chat.session.create", "chat.session.archive", "chat.message.send", "chat.run.cancel",
        "chat.approval.permanent", "kanban.card.create", "kanban.card.update", "kanban.card.comment",
        "profile.create", "profile.update", "profile.delete", "memory.update", "skill.enable", "skill.install",
        "global-settings.update", "runtime.start", "runtime.stop", "runtime.configure", "secret.write", "device.revoke", "audit.read",
      ],
    });

    const rejected = await fetch(`${base}/api/v1/snapshot`, {
      headers: { Origin: "https://attacker.example" },
    });
    assert.equal(rejected.status, 403);
  } finally {
    await server.close();
  }
});

test("launch-scoped desktop capability authenticates Tauri HTTP and WebSocket requests", async () => {
  const desktopCapability = "d".repeat(64);
  const server = createOfficeServer({ port: 0, desktopCapability });
  const address = await server.listen();
  const base = `http://127.0.0.1:${address.port}`;
  const origin = "tauri://localhost";

  try {
    const unauthenticated = await fetch(`${base}/api/v1/snapshot`, { headers: { Origin: origin } });
    assert.equal(unauthenticated.status, 401);

    const authenticated = await fetch(`${base}/api/v1/snapshot`, {
      headers: { Origin: origin, "X-Hermes-Office-Desktop-Capability": desktopCapability },
    });
    assert.equal(authenticated.status, 200);
    assert.equal((await authenticated.json() as { capabilities: { access: { authentication: string } } }).capabilities.access.authentication, "desktop-capability");

    for (const devOrigin of ["http://localhost:4173", "http://127.0.0.1:4173"]) {
      const wrongOrigin = await fetch(`${base}/api/v1/snapshot`, {
        headers: { Origin: devOrigin, "X-Hermes-Office-Desktop-Capability": desktopCapability },
      });
      assert.equal(wrongOrigin.status, 403);
      assert.equal((await fetch(`${base}/api/v1/auth/local`, {
        method: "POST",
        headers: { Origin: devOrigin },
      })).status, 403);
    }

    const preflight = await fetch(`${base}/api/v1/snapshot`, { method: "OPTIONS", headers: { Origin: origin } });
    assert.match(preflight.headers.get("access-control-allow-headers") ?? "", /X-Hermes-Office-Desktop-Capability/);

    const websocket = new WebSocket(
      `${base.replace("http:", "ws:")}/api/v1/events`,
      ["hermes-office.v1", `hermes-office.desktop.${desktopCapability}`],
      { origin },
    );
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error("desktop WebSocket timed out")), 2_000);
      websocket.once("open", () => { clearTimeout(timeout); resolve(); });
      websocket.once("error", reject);
    });
    assert.equal(websocket.protocol, "hermes-office.v1");
    websocket.close();
  } finally {
    await server.close();
  }
});

test("desktop development origin is explicit and cannot be widened to a remote site", async () => {
  const desktopCapability = "e".repeat(64);
  assert.throws(
    () => createOfficeServer({ desktopCapability, desktopOrigins: ["https://office.example"] }),
    /trusted local origins/,
  );
  const server = createOfficeServer({
    port: 0,
    desktopCapability,
    allowedOrigins: ["http://localhost:4173"],
    desktopOrigins: ["http://localhost:4173"],
  });
  const address = await server.listen();
  const base = `http://127.0.0.1:${address.port}`;
  try {
    assert.equal((await fetch(`${base}/api/v1/snapshot`, {
      headers: {
        Origin: "http://localhost:4173",
        "X-Hermes-Office-Desktop-Capability": desktopCapability,
      },
    })).status, 200);
    assert.equal((await fetch(`${base}/api/v1/auth/local`, {
      method: "POST",
      headers: { Origin: "http://localhost:4173" },
    })).status, 200);
    assert.equal((await fetch(`${base}/api/v1/snapshot`, {
      headers: {
        Origin: "tauri://localhost",
        "X-Hermes-Office-Desktop-Capability": desktopCapability,
      },
    })).status, 403);
  } finally {
    await server.close();
  }
});

test("remote origins augment the actual listener origin without trusting unrelated local sites", async () => {
  const remoteOrigin = "https://office.tailnet.example";
  const server = createOfficeServer({ port: 0, allowedOrigins: [remoteOrigin] });
  const address = await server.listen();
  const base = `http://127.0.0.1:${address.port}`;
  try {
    assert.equal(server.originAllowlist.has(remoteOrigin), true);
    assert.equal(server.originAllowlist.has(base), true);
    assert.equal(server.originAllowlist.has(`http://localhost:${address.port}`), true);
    assert.equal((await fetch(`${base}/api/v1/auth/local`, {
      method: "POST",
      headers: { Origin: base },
    })).status, 200);
    for (const deniedOrigin of ["https://attacker.example", "http://localhost:4173", "http://127.0.0.1:4173"]) {
      assert.equal((await fetch(`${base}/api/v1/auth/local`, {
        method: "POST",
        headers: { Origin: deniedOrigin },
      })).status, 403);
    }
  } finally {
    await server.close();
  }
});
