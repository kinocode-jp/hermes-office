import type { AddressInfo } from "node:net";

export const DEFAULT_OFFICE_ORIGINS = [
  "tauri://localhost",
  "http://tauri.localhost",
  "https://tauri.localhost",
] as const;

export function listenerOrigins(address: AddressInfo): readonly string[] {
  const host = address.address.includes(":") ? `[${address.address}]` : address.address;
  const actual = `http://${host}:${address.port}`;
  const loopback = address.address === "127.0.0.1" || address.address === "::1";
  return loopback ? [actual, `http://localhost:${address.port}`] : [actual];
}
