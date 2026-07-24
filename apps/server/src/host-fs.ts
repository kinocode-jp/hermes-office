import { readdir } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join, normalize, sep } from "node:path";

/**
 * Bounded host directory browsing for folder pickers.
 *
 * Read-only, names only (no file contents), depth-one listings. Traversal is
 * limited to absolute, normalized paths; hidden entries and common junk
 * directories are omitted. Errors degrade to an empty listing so the picker
 * never leaks raw errno details to the client.
 */

export interface HostDirListing {
  path: string;
  parent: string | null;
  home: string;
  dirs: { name: string; path: string }[];
  truncated: boolean;
}

const MAX_ENTRIES = 400;
const SKIP_NAMES = new Set(["node_modules", "Library", "System", "Volumes/.timemachine"]);

export async function listHostDirectories(rawPath: string | null): Promise<HostDirListing> {
  const home = homedir();
  let target = rawPath && rawPath.trim() !== "" ? rawPath.trim() : home;
  if (!isAbsolute(target)) target = home;
  target = normalize(target);
  // Collapse any trailing separator (except filesystem root).
  if (target.length > 1 && target.endsWith(sep)) target = target.slice(0, -1);

  let names: string[] = [];
  let truncated = false;
  try {
    const entries = await readdir(target, { withFileTypes: true });
    const dirs = entries
      .filter((entry) => entry.isDirectory() || entry.isSymbolicLink())
      .map((entry) => entry.name)
      .filter((name) => !name.startsWith(".") && !SKIP_NAMES.has(name))
      .sort((a, b) => a.localeCompare(b, undefined, { sensitivity: "base" }));
    truncated = dirs.length > MAX_ENTRIES;
    names = dirs.slice(0, MAX_ENTRIES);
  } catch {
    names = [];
  }

  const root = normalize(sep);
  const parent = target === root ? null : normalize(join(target, ".."));
  return {
    path: target,
    parent,
    home,
    dirs: names.map((name) => ({ name, path: join(target, name) })),
    truncated,
  };
}
