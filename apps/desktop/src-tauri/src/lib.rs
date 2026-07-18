use std::{
    env,
    ffi::OsString,
    io::{Read, Write},
    net::{Ipv4Addr, SocketAddr, TcpListener, TcpStream},
    path::{Path, PathBuf},
    process::{Child, Command, Stdio},
    sync::Mutex,
    thread,
    time::{Duration, Instant},
};
use tauri::{Manager, RunEvent};

const OFFICE_HOST: &str = "127.0.0.1";
const OFFICE_PORT: u16 = 4317;
const START_TIMEOUT: Duration = Duration::from_secs(50);
const STOP_TIMEOUT: Duration = Duration::from_secs(5);
const VERSION_TIMEOUT: Duration = Duration::from_secs(3);
const MAX_VERSION_OUTPUT: u64 = 4096;
const SUPPORTED_NODE_MAJOR: u64 = 22;
const SUPPORTED_HERMES_MAJOR: u64 = 0;
const SUPPORTED_HERMES_MINOR: u64 = 18;

struct OfficeServerProcess(Mutex<Option<Child>>);
struct DesktopCapability(String);

#[tauri::command]
fn desktop_capability(state: tauri::State<'_, DesktopCapability>) -> String {
    state.0.clone()
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let app = tauri::Builder::default()
        .manage(OfficeServerProcess(Mutex::new(None)))
        .manage(DesktopCapability(generate_desktop_capability()))
        .invoke_handler(tauri::generate_handler![desktop_capability])
        .setup(|app| {
            // Tauri owns exactly one Office Server process in every build mode.
            // Release spawns the bundled sidecar; debug spawns the local dev server.
            ensure_office_port_available()?;
            #[cfg(debug_assertions)]
            let mut child = start_office_dev_server(app)?;
            #[cfg(not(debug_assertions))]
            let mut child = start_office_server(app)?;
            if let Err(error) = wait_for_office_server(&mut child, START_TIMEOUT) {
                stop_office_server(&mut child);
                return Err(error);
            }
            *app.state::<OfficeServerProcess>()
                .0
                .lock()
                .expect("server process lock") = Some(child);
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("failed to build Hermes Office");

    app.run(|handle, event| {
        if matches!(event, RunEvent::ExitRequested { .. } | RunEvent::Exit) {
            if let Ok(mut process) = handle.state::<OfficeServerProcess>().0.lock() {
                if let Some(mut child) = process.take() {
                    stop_office_server(&mut child);
                }
            }
        }
    });
}

fn start_office_server(app: &tauri::App) -> Result<Child, Box<dyn std::error::Error>> {
    let resource_dir = app.path().resource_dir()?;
    let script = resource_dir.join("resources/server/hermes-office-server.mjs");
    if !script.is_file() {
        return Err(format!("Office Server resource is missing: {}", script.display()).into());
    }

    let (node, hermes) = resolve_managed_runtime()?;
    let desktop_capability = app.state::<DesktopCapability>().0.clone();

    let mut command = Command::new(node);
    command.env_clear();
    inherit_safe_environment(&mut command);
    // Office remote-device configuration is owned by the host environment, not
    // hardcoded or stored in the browser. Pass it through to the server child
    // only; do not forward it to the managed Hermes runtime.
    inherit_office_remote_environment(&mut command, |key| env::var_os(key));
    command
        .arg(script)
        .env("HERMES_OFFICE_HOST", OFFICE_HOST)
        .env("HERMES_OFFICE_PORT", OFFICE_PORT.to_string())
        .env("HERMES_OFFICE_HERMES_MODE", "managed")
        .env("HERMES_OFFICE_HERMES_EXECUTABLE", hermes)
        .env("HERMES_OFFICE_DESKTOP_CAPABILITY", desktop_capability)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    if let Some(directory) = env::var_os("HOME").map(PathBuf::from) {
        command.current_dir(directory);
    }
    Ok(command.spawn()?)
}

#[cfg(debug_assertions)]
fn start_office_dev_server(app: &tauri::App) -> Result<Child, Box<dyn std::error::Error>> {
    let repo_root = resolve_repo_root()?;
    let (node, hermes) = resolve_managed_runtime()?;
    let desktop_capability = app.state::<DesktopCapability>().0.clone();
    let tsx = resolve_tsx_cli(&repo_root)?;

    let mut command = Command::new(node);
    command.env_clear();
    inherit_safe_environment(&mut command);
    // Office remote-device configuration is owned by the host environment, not
    // hardcoded or stored in the browser. Pass it through to the server child
    // only; do not forward it to the managed Hermes runtime.
    inherit_office_remote_environment(&mut command, |key| env::var_os(key));
    command
        .current_dir(&repo_root)
        .arg(&tsx)
        .arg("watch")
        .arg(repo_root.join("apps/server/src/index.ts"))
        .env("HERMES_OFFICE_HOST", OFFICE_HOST)
        .env("HERMES_OFFICE_PORT", OFFICE_PORT.to_string())
        .env("HERMES_OFFICE_HERMES_MODE", "managed")
        .env("HERMES_OFFICE_HERMES_EXECUTABLE", hermes)
        .env("HERMES_OFFICE_DESKTOP_CAPABILITY", desktop_capability)
        .env("HERMES_OFFICE_DESKTOP_ORIGINS", "http://localhost:4173")
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    Ok(command.spawn()?)
}

#[cfg(debug_assertions)]
fn resolve_tsx_cli(repo_root: &Path) -> Result<PathBuf, Box<dyn std::error::Error>> {
    let candidate = repo_root.join("node_modules/tsx/dist/cli.mjs");
    if !candidate.is_file() {
        return Err(format!(
            "tsx CLI is not installed at {}. Run `npm install` in the repository root.",
            candidate.display()
        )
        .into());
    }
    Ok(candidate)
}

fn resolve_managed_runtime() -> Result<(PathBuf, PathBuf), Box<dyn std::error::Error>> {
    let home = env::var_os("HOME").map(PathBuf::from);
    let node = find_compatible_executable(
        "HERMES_OFFICE_NODE",
        &node_candidates(home.as_deref()),
        node_version_is_compatible,
    )?
    .ok_or("An eligible Node.js 22.x local runtime was not found.")?;
    let hermes = find_compatible_executable(
        "HERMES_OFFICE_HERMES_EXECUTABLE",
        &hermes_candidates(home.as_deref()),
        hermes_version_is_compatible,
    )?
    .ok_or("An eligible, compatible Hermes Agent 0.18.x local runtime was not found.")?;
    Ok((node, hermes))
}

#[cfg(debug_assertions)]
fn resolve_repo_root() -> Result<PathBuf, Box<dyn std::error::Error>> {
    // Tauri dev's current_dir depends on the package manager. Anchor the lookup
    // to the Cargo manifest of this crate for a stable, debug-only path.
    let crate_manifest = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
    let mut current = crate_manifest.as_path();
    loop {
        let package = current.join("package.json");
        let tauri_conf = current.join("apps/desktop/src-tauri/tauri.conf.json");
        if package.is_file() && tauri_conf.is_file() {
            return Ok(current.to_path_buf());
        }
        match current.parent() {
            Some(parent) => current = parent,
            None => break,
        }
    }
    Err("Could not locate the Hermes Office repository root. Ensure the working directory is inside the repository.".into())
}

fn generate_desktop_capability() -> String {
    random_desktop_capability()
}

fn random_desktop_capability() -> String {
    let mut bytes = [0_u8; 32];
    getrandom::fill(&mut bytes).expect("operating system random source is unavailable");
    let mut encoded = String::with_capacity(bytes.len() * 2);
    for byte in bytes {
        use std::fmt::Write as _;
        write!(&mut encoded, "{byte:02x}").expect("writing to a String cannot fail");
    }
    encoded
}

fn ensure_office_port_available() -> Result<(), Box<dyn std::error::Error>> {
    let address = SocketAddr::from((Ipv4Addr::LOCALHOST, OFFICE_PORT));
    let listener = TcpListener::bind(address).map_err(|_| {
        "Office API port 4317 is already in use. Close another Hermes Office instance and retry."
    })?;
    drop(listener);
    Ok(())
}

fn wait_for_office_server(
    child: &mut Child,
    timeout: Duration,
) -> Result<(), Box<dyn std::error::Error>> {
    let deadline = Instant::now() + timeout;
    let address = SocketAddr::from((Ipv4Addr::LOCALHOST, OFFICE_PORT));
    while Instant::now() < deadline {
        if let Some(status) = child.try_wait()? {
            return Err(format!("Office Server exited during startup ({status}).").into());
        }
        if health_check(address) {
            return Ok(());
        }
        thread::sleep(Duration::from_millis(100));
    }
    Err("Office Server did not become ready within 50 seconds.".into())
}

fn health_check(address: SocketAddr) -> bool {
    let Ok(mut stream) = TcpStream::connect_timeout(&address, Duration::from_millis(200)) else {
        return false;
    };
    let timeout = Some(Duration::from_millis(500));
    if stream.set_read_timeout(timeout).is_err() || stream.set_write_timeout(timeout).is_err() {
        return false;
    }
    if stream
        .write_all(
            b"GET /api/v1/health HTTP/1.1\r\nHost: 127.0.0.1:4317\r\nConnection: close\r\n\r\n",
        )
        .is_err()
    {
        return false;
    }
    let mut response = [0_u8; 2048];
    let Ok(size) = stream.read(&mut response) else {
        return false;
    };
    let text = String::from_utf8_lossy(&response[..size]);
    text.starts_with("HTTP/1.1 200") && text.contains("\"protocolVersion\"")
}

fn stop_office_server(child: &mut Child) {
    if child.try_wait().ok().flatten().is_some() {
        return;
    }
    send_terminate(child);
    let deadline = Instant::now() + STOP_TIMEOUT;
    while Instant::now() < deadline {
        if child.try_wait().ok().flatten().is_some() {
            return;
        }
        thread::sleep(Duration::from_millis(100));
    }
    let _ = child.kill();
    let _ = child.wait();
}

#[cfg(unix)]
fn send_terminate(child: &mut Child) {
    // Office Server handles SIGTERM and closes its managed Hermes processes.
    unsafe {
        libc::kill(child.id() as libc::pid_t, libc::SIGTERM);
    }
}

#[cfg(not(unix))]
fn send_terminate(child: &mut Child) {
    let _ = child.kill();
}

fn find_compatible_executable(
    override_name: &str,
    candidates: &[PathBuf],
    version_is_compatible: fn(&str) -> bool,
) -> Result<Option<PathBuf>, String> {
    if let Some(value) = env::var_os(override_name).filter(|value| !value.is_empty()) {
        let path = PathBuf::from(value);
        let executable = validated_local_executable(&path).ok_or_else(|| {
            format!("{override_name} must identify an eligible absolute executable")
        })?;
        let version = run_version_command(&executable)?;
        if !version_is_compatible(&version) {
            return Err(format!("{override_name} has an unsupported version"));
        }
        return Ok(Some(executable));
    }
    for path in candidates {
        let Some(executable) = validated_local_executable(path) else {
            continue;
        };
        let Ok(version) = run_version_command(&executable) else {
            continue;
        };
        if version_is_compatible(&version) {
            return Ok(Some(executable));
        }
    }
    Ok(None)
}

// This validates a local-install boundary; it does not attest publisher identity
// or protect against replacement by the same OS user who owns the executable.
fn validated_local_executable(path: &Path) -> Option<PathBuf> {
    if !path.is_absolute() {
        return None;
    }
    let canonical = path.canonicalize().ok()?;
    let metadata = canonical.metadata().ok()?;
    if !metadata.is_file() {
        return None;
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::{MetadataExt, PermissionsExt};
        let mode = metadata.permissions().mode();
        let owner = metadata.uid();
        let effective_user = unsafe { libc::geteuid() };
        if mode & 0o6000 != 0
            || mode & 0o111 == 0
            || mode & 0o022 != 0
            || (owner != 0 && owner != effective_user)
        {
            return None;
        }
    }
    Some(canonical)
}

fn run_version_command(path: &Path) -> Result<String, String> {
    let mut command = Command::new(path);
    command
        .arg("--version")
        .env_clear()
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    inherit_safe_environment(&mut command);
    let mut child = command.spawn().map_err(|_| "runtime version probe failed".to_owned())?;
    let stdout = child.stdout.take().ok_or_else(|| "runtime version output unavailable".to_owned())?;
    let stderr = child.stderr.take().ok_or_else(|| "runtime version output unavailable".to_owned())?;
    let stdout_reader = thread::spawn(move || read_limited(stdout));
    let stderr_reader = thread::spawn(move || read_limited(stderr));
    let deadline = Instant::now() + VERSION_TIMEOUT;
    let status = loop {
        match child.try_wait().map_err(|_| "runtime version probe failed".to_owned())? {
            Some(status) => break status,
            None if Instant::now() < deadline => thread::sleep(Duration::from_millis(20)),
            None => {
                let _ = child.kill();
                let _ = child.wait();
                return Err("runtime version probe timed out".to_owned());
            }
        }
    };
    let stdout = stdout_reader.join().map_err(|_| "runtime version probe failed".to_owned())??;
    let stderr = stderr_reader.join().map_err(|_| "runtime version probe failed".to_owned())??;
    if !status.success() {
        return Err("runtime version probe failed".to_owned());
    }
    let output = if stdout.is_empty() { stderr } else { stdout };
    String::from_utf8(output)
        .map(|value| value.trim().to_owned())
        .map_err(|_| "runtime version output is not UTF-8".to_owned())
}

fn read_limited(reader: impl Read) -> Result<Vec<u8>, String> {
    let mut bytes = Vec::new();
    reader
        .take(MAX_VERSION_OUTPUT + 1)
        .read_to_end(&mut bytes)
        .map_err(|_| "runtime version output could not be read".to_owned())?;
    if bytes.len() as u64 > MAX_VERSION_OUTPUT {
        return Err("runtime version output exceeded its limit".to_owned());
    }
    Ok(bytes)
}

fn node_version_is_compatible(output: &str) -> bool {
    parse_leading_version(output.strip_prefix('v').unwrap_or(output))
        .is_some_and(|(major, _, _)| major == SUPPORTED_NODE_MAJOR)
}

fn hermes_version_is_compatible(output: &str) -> bool {
    let Some(version) = output.lines().find_map(|line| line.strip_prefix("Hermes Agent v")) else {
        return false;
    };
    parse_leading_version(version).is_some_and(|(major, minor, _)| {
        major == SUPPORTED_HERMES_MAJOR && minor == SUPPORTED_HERMES_MINOR
    })
}

fn parse_leading_version(value: &str) -> Option<(u64, u64, u64)> {
    let version = value.split_whitespace().next()?;
    let core = version.split(['-', '+']).next()?;
    let mut components = core.split('.');
    let result = (
        components.next()?.parse().ok()?,
        components.next()?.parse().ok()?,
        components.next()?.parse().ok()?,
    );
    (components.next().is_none()).then_some(result)
}

fn inherit_safe_environment(command: &mut Command) {
    for key in [
        "HOME", "PATH", "USER", "LOGNAME", "SHELL", "TMPDIR", "TEMP", "TMP",
        "XDG_CONFIG_HOME", "XDG_DATA_HOME", "XDG_CACHE_HOME", "LANG", "LANGUAGE",
        "LC_ALL", "LC_CTYPE", "TZ", "SYSTEMROOT", "WINDIR", "COMSPEC", "PATHEXT",
    ] {
        if let Some(value) = env::var_os(key).filter(|value| !value.is_empty()) {
            command.env(key, value);
        }
    }
}

/// Office remote-device configuration is only meaningful to the Office server
/// child. Preserve it across env_clear so a host owner can launch remote
/// access without putting tokens in the browser or source files.
fn inherit_office_remote_environment(command: &mut Command, lookup: impl Fn(&str) -> Option<OsString>) {
    for key in [
        "HERMES_OFFICE_REMOTE_TOKEN",
        "HERMES_OFFICE_ALLOWED_ORIGINS",
        "HERMES_OFFICE_TRUSTED_PROXY_HOPS",
    ] {
        if let Some(value) = lookup(key).filter(|value| !value.is_empty()) {
            command.env(key, value);
        }
    }
}

fn node_candidates(home: Option<&Path>) -> Vec<PathBuf> {
    let mut values = Vec::new();
    if let Some(home) = home {
        values.push(home.join(".hermes/node/bin/node"));
        values.push(home.join(".local/bin/node"));
    }
    values.extend([
        PathBuf::from("/opt/homebrew/bin/node"),
        PathBuf::from("/usr/local/bin/node"),
        PathBuf::from("/usr/bin/node"),
    ]);
    values
}

fn hermes_candidates(home: Option<&Path>) -> Vec<PathBuf> {
    let mut values = Vec::new();
    if let Some(home) = home {
        values.push(home.join(".local/bin/hermes"));
        values.push(home.join(".hermes/hermes-agent/venv/bin/hermes"));
        values.push(home.join(".hermes/hermes-agent/hermes"));
    }
    values.extend([
        PathBuf::from("/opt/homebrew/bin/hermes"),
        PathBuf::from("/usr/local/bin/hermes"),
    ]);
    values
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn executable_fallbacks_are_absolute() {
        assert!(node_candidates(None).iter().all(|path| path.is_absolute()));
        assert!(hermes_candidates(None)
            .iter()
            .all(|path| path.is_absolute()));
    }

    #[test]
    fn runtime_versions_are_fail_closed() {
        assert!(node_version_is_compatible("v22.17.0"));
        assert!(!node_version_is_compatible("v23.0.0"));
        assert!(!node_version_is_compatible("v24.0.1"));
        assert!(!node_version_is_compatible("v21.9.0"));
        assert!(!node_version_is_compatible("not-node"));
        assert!(hermes_version_is_compatible("Hermes Agent v0.18.2"));
        assert!(!hermes_version_is_compatible("Hermes Agent v0.19.0"));
        assert!(!hermes_version_is_compatible("0.18.2"));
    }

    #[test]
    #[cfg(unix)]
    fn executable_validation_canonicalizes_and_rejects_writable_files() {
        use std::fs;
        use std::os::unix::fs::{symlink, PermissionsExt};

        let directory = env::temp_dir().join(format!(
            "hermes-office-runtime-validation-{}-{}",
            std::process::id(),
            random_desktop_capability(),
        ));
        fs::create_dir(&directory).expect("create fixture directory");
        let executable = directory.join("runtime");
        fs::write(&executable, b"#!/bin/sh\nexit 0\n").expect("write fixture executable");
        fs::set_permissions(&executable, fs::Permissions::from_mode(0o755))
            .expect("make fixture executable");
        let link = directory.join("runtime-link");
        symlink(&executable, &link).expect("create fixture symlink");

        assert_eq!(
            validated_local_executable(&link),
            Some(executable.canonicalize().expect("canonical fixture path")),
        );
        fs::set_permissions(&executable, fs::Permissions::from_mode(0o777))
            .expect("make fixture writable");
        assert_eq!(validated_local_executable(&link), None);

        fs::set_permissions(&executable, fs::Permissions::from_mode(0o4755))
            .expect("make fixture setuid");
        assert_eq!(validated_local_executable(&link), None);

        fs::set_permissions(&executable, fs::Permissions::from_mode(0o2755))
            .expect("make fixture setgid");
        assert_eq!(validated_local_executable(&link), None);

        fs::remove_dir_all(directory).expect("remove fixture directory");
    }

    #[test]
    fn desktop_capabilities_are_url_safe_and_launch_scoped() {
        let first = random_desktop_capability();
        let second = random_desktop_capability();
        assert_eq!(first.len(), 64);
        assert!(first.chars().all(|value| value.is_ascii_hexdigit()));
        assert_ne!(first, second);
    }

    #[test]
    fn generate_desktop_capability_is_random_in_all_builds() {
        let first = generate_desktop_capability();
        let second = generate_desktop_capability();
        assert_eq!(first.len(), 64);
        assert!(first.chars().all(|value| value.is_ascii_hexdigit()));
        assert_ne!(first, second);
    }

    #[test]
    fn office_remote_environment_allowlist_is_exact_when_host_values_present() {
        let mut lookup = std::collections::HashMap::new();
        lookup.insert("HERMES_OFFICE_REMOTE_TOKEN", OsString::from("office-token"));
        lookup.insert("HERMES_OFFICE_ALLOWED_ORIGINS", OsString::from("https://office.example"));
        lookup.insert("HERMES_OFFICE_TRUSTED_PROXY_HOPS", OsString::from("1"));
        let mut command = Command::new("/bin/sh");
        command.env_clear();
        inherit_office_remote_environment(&mut command, |key| lookup.get(key).cloned());
        let envs: Vec<(String, String)> = command
            .get_envs()
            .filter_map(|(k, v)| {
                v.map(|v| (k.to_string_lossy().into_owned(), v.to_string_lossy().into_owned()))
            })
            .collect();
        assert!(envs.contains(&("HERMES_OFFICE_REMOTE_TOKEN".to_string(), "office-token".to_string())));
        assert!(envs.contains(&("HERMES_OFFICE_ALLOWED_ORIGINS".to_string(), "https://office.example".to_string())));
        assert!(envs.contains(&("HERMES_OFFICE_TRUSTED_PROXY_HOPS".to_string(), "1".to_string())));
        assert_eq!(envs.len(), 3, "only the three allowed Office keys may be forwarded");
    }

    #[test]
    fn office_remote_environment_allowlist_ignores_empty_or_missing_values() {
        let mut lookup = std::collections::HashMap::new();
        lookup.insert("HERMES_OFFICE_REMOTE_TOKEN", OsString::from(""));
        let mut command = Command::new("/bin/sh");
        command.env_clear();
        inherit_office_remote_environment(&mut command, |key| lookup.get(key).cloned());
        let envs: Vec<(String, String)> = command
            .get_envs()
            .filter_map(|(k, v)| {
                v.map(|v| (k.to_string_lossy().into_owned(), v.to_string_lossy().into_owned()))
            })
            .collect();
        assert!(envs.is_empty(), "empty or absent host values must not be forwarded");
    }
}
