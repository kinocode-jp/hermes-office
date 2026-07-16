import assert from "node:assert/strict";
import test from "node:test";
import {
  classifyDeviceLoginFailure,
  isLocalOfficeClient,
  normalizeDeviceName,
  shouldShowDeviceEnrollmentForm,
} from "../src/auth-state.ts";

test("local and Tauri clients keep local bootstrap while remote origins require device auth", () => {
  assert.equal(isLocalOfficeClient({ protocol: "http:", hostname: "localhost" }), true);
  assert.equal(isLocalOfficeClient({ protocol: "tauri:", hostname: "localhost" }), true);
  assert.equal(isLocalOfficeClient({ protocol: "https:", hostname: "tauri.localhost" }), true);
  assert.equal(isLocalOfficeClient({ protocol: "https:", hostname: "office.tailnet.example" }), false);
});

test("device login failures expose bounded action-oriented messages", () => {
  assert.deepEqual(classifyDeviceLoginFailure(429, "60"), {
    code: "rate-limited",
    message: "試行回数の上限に達しました。60秒後にもう一度お試しください。",
    retryAfterSeconds: 60
  });
  assert.equal(classifyDeviceLoginFailure(404, null).code, "disabled");
  assert.equal(classifyDeviceLoginFailure(401, null).code, "invalid");
  assert.equal(classifyDeviceLoginFailure(500, null).code, "unavailable");
  assert.equal(classifyDeviceLoginFailure(429, "99999").retryAfterSeconds, undefined);
});

test("device names are normalized without accepting control characters", () => {
  assert.equal(normalizeDeviceName("  Travel phone  "), "Travel phone");
  assert.equal(normalizeDeviceName(""), undefined);
  assert.equal(normalizeDeviceName(`phone\nname`), undefined);
  assert.equal(normalizeDeviceName("x".repeat(65)), undefined);
});

test("temporary Office unavailability never asks for a new device enrollment token", () => {
  assert.equal(shouldShowDeviceEnrollmentForm("login-required"), true);
  assert.equal(shouldShowDeviceEnrollmentForm("submitting"), true);
  assert.equal(shouldShowDeviceEnrollmentForm("unavailable"), false);
  assert.equal(shouldShowDeviceEnrollmentForm("checking"), false);
  assert.equal(shouldShowDeviceEnrollmentForm("authenticated"), false);
});
