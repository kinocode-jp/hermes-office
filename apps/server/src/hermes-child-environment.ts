import type { Readable } from "node:stream";

const INHERITED_ENVIRONMENT_KEYS = [
  "HOME", "PATH", "USER", "LOGNAME", "SHELL", "TMPDIR", "TEMP", "TMP",
  "XDG_CONFIG_HOME", "XDG_DATA_HOME", "XDG_CACHE_HOME", "LANG", "LANGUAGE",
  "LC_ALL", "LC_CTYPE", "TZ", "NO_COLOR", "FORCE_COLOR", "SYSTEMROOT",
  "WINDIR", "COMSPEC", "PATHEXT", "HERMES_HOME",
] as const;

export interface HermesChildEnvironmentOverrides {
  sessionToken: string;
  cwd: string;
}

/** Construct the complete allowlisted environment for an untrusted Hermes runtime. */
export function createHermesChildEnvironment(
  overrides: HermesChildEnvironmentOverrides,
  source: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = {};
  for (const key of INHERITED_ENVIRONMENT_KEYS) {
    const value = source[key];
    if (value !== undefined && value !== "" && !value.includes("\0")) environment[key] = value;
  }
  environment.HERMES_DASHBOARD_SESSION_TOKEN = overrides.sessionToken;
  environment.HERMES_DESKTOP = "1";
  environment.TERMINAL_CWD = overrides.cwd;
  return environment;
}

/** Keep child pipes flowing without retaining or exposing potentially sensitive logs. */
export function discardHermesChildOutput(child: { stdout: Readable; stderr: Readable }): void {
  child.stdout.resume();
  child.stderr.resume();
}
