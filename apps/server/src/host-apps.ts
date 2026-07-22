import { existsSync } from "node:fs";
import { homedir, platform } from "node:os";
import { join } from "node:path";
import { spawn, type ChildProcess } from "node:child_process";
import type { HostAppStatus } from "@hermes-studio/protocol";

const OBSIDIAN_APP_PATHS = [
  "/Applications/Obsidian.app",
  join(homedir(), "Applications", "Obsidian.app"),
] as const;
const HOMEBREW_PATHS = ["/opt/homebrew/bin/brew", "/usr/local/bin/brew"] as const;
const INSTALL_TIMEOUT_MS = 20 * 60 * 1_000;

/**
 * Fixed-function host application manager. It intentionally accepts no app id,
 * package name, executable, arguments, or shell input from HTTP clients.
 */
export class HostAppManager {
  #phase: HostAppStatus["phase"] | undefined;
  #failure: HostAppStatus["failure"];
  #installer: ChildProcess | undefined;
  #timeout: ReturnType<typeof setTimeout> | undefined;

  obsidianStatus(): HostAppStatus {
    if (OBSIDIAN_APP_PATHS.some((candidate) => existsSync(candidate))) {
      this.#phase = "installed";
      this.#failure = undefined;
      return status("installed", true, false);
    }
    if (platform() !== "darwin") return status("unsupported", false, false, "unsupported_platform");
    if (this.#installer !== undefined || this.#phase === "installing") return status("installing", false, false);
    const brew = homebrewPath();
    if (brew === undefined) return status("blocked", false, false, "homebrew_missing");
    if (this.#phase === "failed") return status("failed", false, true, this.#failure ?? "install_failed");
    return status("available", false, true);
  }

  installObsidian(): HostAppStatus {
    const current = this.obsidianStatus();
    if (current.phase === "installed" || current.phase === "installing" || !current.canInstall) return current;
    const brew = homebrewPath();
    if (brew === undefined) return status("blocked", false, false, "homebrew_missing");

    this.#phase = "installing";
    this.#failure = undefined;
    const child = spawn(brew, ["install", "--cask", "obsidian"], {
      shell: false,
      stdio: "ignore",
      env: process.env,
    });
    this.#installer = child;
    this.#timeout = setTimeout(() => {
      if (this.#installer !== child) return;
      this.#failure = "install_timeout";
      this.#phase = "failed";
      child.kill("SIGTERM");
    }, INSTALL_TIMEOUT_MS);
    this.#timeout.unref?.();

    child.once("error", () => this.#finish(child, false));
    child.once("exit", (code) => this.#finish(child, code === 0));
    return this.obsidianStatus();
  }

  close(): void {
    if (this.#timeout !== undefined) clearTimeout(this.#timeout);
    this.#timeout = undefined;
    this.#installer?.kill("SIGTERM");
    this.#installer = undefined;
  }

  #finish(child: ChildProcess, succeeded: boolean): void {
    if (this.#installer !== child) return;
    if (this.#timeout !== undefined) clearTimeout(this.#timeout);
    this.#timeout = undefined;
    this.#installer = undefined;
    if (succeeded && OBSIDIAN_APP_PATHS.some((candidate) => existsSync(candidate))) {
      this.#phase = "installed";
      this.#failure = undefined;
      return;
    }
    this.#phase = "failed";
    this.#failure ??= "install_failed";
  }
}

function homebrewPath(): string | undefined {
  return HOMEBREW_PATHS.find((candidate) => existsSync(candidate));
}

function status(
  phase: HostAppStatus["phase"],
  installed: boolean,
  canInstall: boolean,
  failure?: HostAppStatus["failure"],
): HostAppStatus {
  return {
    id: "obsidian",
    name: "Obsidian",
    phase,
    installed,
    canInstall,
    installMethod: "homebrew-cask",
    ...(failure === undefined ? {} : { failure }),
  };
}
