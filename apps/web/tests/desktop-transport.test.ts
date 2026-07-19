import assert from "node:assert/strict";
import test from "node:test";
import {
  desktopCapabilityHeader,
  isTauriAssetLocation,
  shouldUseDesktopCapability,
} from "../src/desktop-transport.ts";

test("desktop transport is limited to Tauri asset origins", () => {
  assert.equal(isTauriAssetLocation({ protocol: "tauri:", hostname: "localhost" } as Location), true);
  assert.equal(isTauriAssetLocation({ protocol: "https:", hostname: "tauri.localhost" } as Location), true);
  assert.equal(isTauriAssetLocation({ protocol: "http:", hostname: "localhost" } as Location), false);
  assert.equal(isTauriAssetLocation({ protocol: "https:", hostname: "office.example" } as Location), false);
});

test("Tauri dev uses IPC capability while a normal localhost browser keeps cookie auth", () => {
  const devLocation = { protocol: "http:", hostname: "localhost" } as Location;
  assert.equal(shouldUseDesktopCapability(devLocation, true), true);
  assert.equal(shouldUseDesktopCapability(devLocation, false), false);
});

test("desktop capability is sent only through its dedicated header", () => {
  assert.deepEqual(desktopCapabilityHeader(undefined), {});
  assert.deepEqual(desktopCapabilityHeader("a".repeat(64)), {
    "X-Hermes-Office-Desktop-Capability": "a".repeat(64),
  });
});
