import type { IncomingMessage } from "node:http";

const MAX_DEVICE_AUTH_BYTES = 8 * 1024;

export class DeviceAuthBodyError extends Error {
  readonly status: 400 | 413;

  constructor(status: 400 | 413, message: string) {
    super(message);
    this.name = "DeviceAuthBodyError";
    this.status = status;
  }
}

export async function readDeviceAuthBody(
  request: IncomingMessage,
  maxJsonBytes: number,
): Promise<{ token: string; deviceName: string }> {
  const contentType = request.headers["content-type"]?.split(";", 1)[0]?.trim().toLowerCase();
  if (contentType !== "application/json") {
    request.resume();
    throw new DeviceAuthBodyError(400, "Content-Type must be application/json.");
  }
  const limit = Math.min(MAX_DEVICE_AUTH_BYTES, maxJsonBytes);
  const declared = request.headers["content-length"];
  if (declared !== undefined) {
    const size = Number(declared);
    if (!Number.isSafeInteger(size) || size < 0) {
      request.resume();
      throw new DeviceAuthBodyError(400, "Content-Length is invalid.");
    }
    if (size > limit) {
      request.resume();
      throw new DeviceAuthBodyError(413, "Device authentication request is too large.");
    }
  }

  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array);
    size += buffer.byteLength;
    if (size > limit) {
      request.resume();
      throw new DeviceAuthBodyError(413, "Device authentication request is too large.");
    }
    chunks.push(buffer);
  }
  if (size === 0) throw new DeviceAuthBodyError(400, "A JSON request body is required.");

  let value: unknown;
  try {
    value = JSON.parse(Buffer.concat(chunks, size).toString("utf8")) as unknown;
  } catch {
    throw new DeviceAuthBodyError(400, "Request body must be valid JSON.");
  }
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new DeviceAuthBodyError(400, "Request body must be a JSON object.");
  }
  const record = value as Record<string, unknown>;
  if (Object.keys(record).some((key) => key !== "token" && key !== "deviceName")) {
    throw new DeviceAuthBodyError(400, "Device authentication fields are invalid.");
  }
  if (typeof record.token !== "string" || record.token.length > 4_096 || record.token.includes("\0")) {
    throw new DeviceAuthBodyError(400, "Device credentials are invalid.");
  }
  if (typeof record.deviceName !== "string") {
    throw new DeviceAuthBodyError(400, "Device credentials are invalid.");
  }
  const deviceName = record.deviceName.trim();
  if (deviceName.length < 1 || deviceName.length > 64 || /[\u0000-\u001f\u007f]/.test(deviceName)) {
    throw new DeviceAuthBodyError(400, "Device credentials are invalid.");
  }
  return { token: record.token, deviceName };
}
