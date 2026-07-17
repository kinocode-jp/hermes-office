import { realpathSync, statSync } from "node:fs";
import { readFile, realpath, stat } from "node:fs/promises";
import { extname, resolve, sep } from "node:path";

const MAX_ASSET_BYTES = 12 * 1024 * 1024;

export type StaticWebAsset = {
  body: Buffer;
  contentType: string;
  cacheControl: string;
};

export class StaticWebAssets {
  readonly root: string;
  readonly #realRoot: string;

  constructor(root: string) {
    if (!root.trim()) throw new Error("Static web root is required.");
    this.root = resolve(root);
    this.#realRoot = realpathSync(this.root);
    if (!statSync(this.#realRoot).isDirectory()) throw new Error("Static web root must be a directory.");
  }

  async read(pathname: string): Promise<StaticWebAsset | undefined> {
    const relative = safeRelativePath(pathname);
    if (
      relative === undefined
      || relative === "api"
      || relative.startsWith("api/")
      || relative === "assets"
    ) return undefined;

    const requested = relative === "" ? "index.html" : relative;
    const direct = await this.readFile(requested);
    if (direct) return direct;

    // The app is a client-side router. Only extensionless navigation paths may
    // fall back to the shell; missing scripts/styles must remain a real 404.
    if (extname(requested) !== "") return undefined;
    return await this.readFile("index.html", false);
  }

  private async readFile(relative: string, immutable = true): Promise<StaticWebAsset | undefined> {
    try {
      const root = this.#realRoot;
      const candidate = resolve(root, relative);
      if (candidate !== root && !candidate.startsWith(`${root}${sep}`)) return undefined;
      const canonical = await realpath(candidate);
      if (canonical !== root && !canonical.startsWith(`${root}${sep}`)) return undefined;
      const details = await stat(canonical);
      if (!details.isFile() || details.size > MAX_ASSET_BYTES) return undefined;
      return {
        body: await readFile(canonical),
        contentType: contentType(canonical),
        cacheControl: immutable && relative.startsWith("assets/")
          ? "public, max-age=31536000, immutable"
          : "no-cache",
      };
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "ENOENT" || code === "ENOTDIR" || code === "EACCES") return undefined;
      throw error;
    }
  }
}

function safeRelativePath(pathname: string): string | undefined {
  let decoded: string;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    return undefined;
  }
  if (!decoded.startsWith("/") || decoded.includes("\0") || decoded.includes("\\")) return undefined;
  const segments = decoded.slice(1).split("/");
  if (segments.some((segment) => segment === ".." || segment === "." || segment.startsWith("."))) return undefined;
  return segments.filter(Boolean).join("/");
}

function contentType(path: string): string {
  switch (extname(path).toLowerCase()) {
    case ".html": return "text/html; charset=utf-8";
    case ".js": case ".mjs": return "text/javascript; charset=utf-8";
    case ".css": return "text/css; charset=utf-8";
    case ".json": return "application/json; charset=utf-8";
    case ".webmanifest": return "application/manifest+json; charset=utf-8";
    case ".svg": return "image/svg+xml";
    case ".png": return "image/png";
    case ".webp": return "image/webp";
    case ".ico": return "image/x-icon";
    case ".woff": return "font/woff";
    case ".woff2": return "font/woff2";
    default: return "application/octet-stream";
  }
}
