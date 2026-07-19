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
const OFFICE_PROTOCOL_VERSION: i64 = 1;
const START_TIMEOUT: Duration = Duration::from_secs(50);
const STOP_TIMEOUT: Duration = Duration::from_secs(5);
const VERSION_TIMEOUT: Duration = Duration::from_secs(3);
const MAX_VERSION_OUTPUT: u64 = 4096;
const MAX_HTTP_HEADERS: usize = 8192;
const MAX_HEALTH_RESPONSE: u64 = 4096;
const DESKTOP_CAPABILITY_HEADER: &str = "X-Hermes-Office-Desktop-Capability";
const SUPPORTED_NODE_MAJOR: u64 = 22;
const SUPPORTED_HERMES_MAJOR: u64 = 0;
const SUPPORTED_HERMES_MINOR: u64 = 18;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum OfficeStartup {
    /// Loopback port is free; this desktop instance should start and own the
    /// Office Server child.
    PortFree,
    /// A compatible Office Server is already listening on the port. This
    /// desktop instance will attach without spawning or killing anything.
    AttachExisting,
}

#[derive(Debug, Clone, PartialEq, Eq)]
enum StartupProbeError {
    Incompatible,
    Malformed,
    Timeout,
    OtherService,
}
impl std::fmt::Display for StartupProbeError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            StartupProbeError::Incompatible => {
                write!(formatter, "An existing Office Server is listening on port {OFFICE_PORT}, but it reports an incompatible protocol version. Close the incompatible instance or start Office Server manually with a compatible version.")
            }
            StartupProbeError::Malformed => {
                write!(formatter, "An existing Office Server is listening on port {OFFICE_PORT}, but its health response was malformed. Close the instance or start Office Server manually.")
            }
            StartupProbeError::Timeout => {
                write!(formatter, "An existing Office Server is listening on port {OFFICE_PORT}, but its health response timed out. Close the instance or start Office Server manually.")
            }
            StartupProbeError::OtherService => {
                write!(formatter, "Port {OFFICE_PORT} is already in use by a non-Hermes Office service. Close that service before starting Hermes Office.")
            }
        }
    }
}

impl std::error::Error for StartupProbeError {}

struct OfficeServerProcess(Mutex<Option<Child>>);
struct DesktopCapability(Mutex<Option<String>>);

#[tauri::command]
fn desktop_capability(state: tauri::State<'_, DesktopCapability>) -> Option<String> {
    state.0.lock().expect("desktop capability lock").clone()
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let app = tauri::Builder::default()
        .manage(OfficeServerProcess(Mutex::new(None)))
        .manage(DesktopCapability(Mutex::new(None)))
        .invoke_handler(tauri::generate_handler![desktop_capability])
        .setup(|app| {
            // The desktop shell is Web-first: it can start its own Office Server
            // child or attach to an existing compatible server already listening on
            // the configured loopback port. It never spawns, stops, or kills an
            // independently started server.
            let capability_state = app.state::<DesktopCapability>();
            let address = SocketAddr::from((Ipv4Addr::LOCALHOST, OFFICE_PORT));
            match classify_office_startup(address)? {
                OfficeStartup::PortFree => {
                    let desktop_capability = generate_desktop_capability();
                    *capability_state
                        .0
                        .lock()
                        .expect("desktop capability lock") = Some(desktop_capability.clone());
                    #[cfg(debug_assertions)]
                    let mut child = start_office_dev_server(app, &desktop_capability)?;
                    #[cfg(not(debug_assertions))]
                    let mut child = start_office_server(app, &desktop_capability)?;
                    if let Err(error) =
                        wait_for_office_server(&mut child, START_TIMEOUT, &desktop_capability)
                    {
                        stop_office_server(&mut child);
                        return Err(error);
                    }
                    *app.state::<OfficeServerProcess>()
                        .0
                        .lock()
                        .expect("server process lock") = Some(child);
                }
                OfficeStartup::AttachExisting => {
                    // An existing compatible server is already running. We do not
                    // verify the desktop capability against it, because an
                    // independently started server cannot know this desktop
                    // instance's ephemeral capability. OfficeServerProcess stays
                    // None so app exit does not stop the external server.
                    //
                    // A tauri://localhost top-level page cannot reliably use the
                    // existing server's SameSite=Strict local session cookie from
                    // a cross-origin fetch. Navigate the main WebView to the
                    // server origin so the web UI becomes a same-origin ordinary
                    // browser page, using browser-equivalent local cookie auth.
                    // The capability state remains None; the attached remote page
                    // has no Tauri desktop capability and therefore no host
                    // administration panel.
                    let main_window = app
                        .get_webview_window("main")
                        .ok_or("Hermes Office main window is unavailable.")?;
                    let target_url = format!("http://{OFFICE_HOST}:{OFFICE_PORT}/");
                    main_window.navigate(
                        target_url
                            .parse()
                            .map_err(|_| "Failed to parse Office Server origin.")?,
                    )?;
                }
            }
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

fn start_office_server(
    app: &tauri::App,
    desktop_capability: &str,
) -> Result<Child, Box<dyn std::error::Error>> {
    let resource_dir = app.path().resource_dir()?;
    let script = resource_dir.join("resources/server/hermes-office-server.mjs");
    if !script.is_file() {
        return Err(format!("Office Server resource is missing: {}", script.display()).into());
    }

    let (node, hermes) = resolve_managed_runtime()?;

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
    let home = env::var_os("HOME").map(PathBuf::from);
    let current_dir = home.filter(|path| path.is_dir()).unwrap_or(resource_dir);
    command.current_dir(current_dir);
    Ok(command.spawn()?)
}

#[cfg(debug_assertions)]
fn start_office_dev_server(
    app: &tauri::App,
    desktop_capability: &str,
) -> Result<Child, Box<dyn std::error::Error>> {
    let repo_root = resolve_repo_root()?;
    let (node, hermes) = resolve_managed_runtime()?;
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
        .stdout(Stdio::inherit())
        .stderr(Stdio::inherit());
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

fn classify_office_startup(
    address: SocketAddr,
) -> Result<OfficeStartup, Box<dyn std::error::Error>> {
    if let Ok(listener) = TcpListener::bind(address) {
        drop(listener);
        return Ok(OfficeStartup::PortFree);
    }

    match probe_existing_health(address) {
        ProbeOutcome::Compatible => Ok(OfficeStartup::AttachExisting),
        ProbeOutcome::Incompatible => Err(StartupProbeError::Incompatible.into()),
        ProbeOutcome::Malformed => Err(StartupProbeError::Malformed.into()),
        ProbeOutcome::Timeout => Err(StartupProbeError::Timeout.into()),
        ProbeOutcome::OtherService => Err(StartupProbeError::OtherService.into()),
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum ProbeOutcome {
    Compatible,
    Incompatible,
    Malformed,
    Timeout,
    OtherService,
}

fn probe_existing_health(address: SocketAddr) -> ProbeOutcome {
    let Ok(mut stream) = TcpStream::connect_timeout(&address, Duration::from_millis(200)) else {
        return ProbeOutcome::OtherService;
    };
    let timeout = Some(Duration::from_millis(500));
    if stream.set_read_timeout(timeout).is_err() || stream.set_write_timeout(timeout).is_err() {
        return ProbeOutcome::Timeout;
    }
    let host = format!("{address}");
    let request =
        format!("GET /api/v1/health HTTP/1.1\r\nHost: {host}\r\nConnection: close\r\n\r\n");
    if stream.write_all(request.as_bytes()).is_err() {
        return ProbeOutcome::OtherService;
    }
    let mut response = Vec::new();
    let read_result = stream
        .take(MAX_HEALTH_RESPONSE + 1)
        .read_to_end(&mut response);
    match read_result {
        Ok(()) if response.len() as u64 > MAX_HEALTH_RESPONSE => return ProbeOutcome::Malformed,
        Ok(()) => {}
        Err(error) if matches!(error.kind(), std::io::ErrorKind::WouldBlock | std::io::ErrorKind::TimedOut) => {
            return ProbeOutcome::Timeout;
        }
        Err(_) => return ProbeOutcome::Malformed,
    }
    let text = match String::from_utf8(response) {
        Ok(value) => value,
        Err(_) => return ProbeOutcome::Malformed,
    };
    let Some((headers, body)) = text.split_once("\r\n\r\n") else {
        return ProbeOutcome::Malformed;
    };
    if !http_status_is_ok(headers) {
        return ProbeOutcome::OtherService;
    }
    match classify_health_body(body) {
        HealthCompatibility::Compatible => ProbeOutcome::Compatible,
        HealthCompatibility::Incompatible => ProbeOutcome::Incompatible,
        HealthCompatibility::Malformed => ProbeOutcome::Malformed,
    }
}

fn wait_for_office_server(
    child: &mut Child,
    timeout: Duration,
    desktop_capability: &str,
) -> Result<(), Box<dyn std::error::Error>> {
    let deadline = Instant::now() + timeout;
    let address = SocketAddr::from((Ipv4Addr::LOCALHOST, OFFICE_PORT));
    while Instant::now() < deadline {
        if let Some(status) = child.try_wait()? {
            return Err(format!("Office Server exited during startup ({status}).").into());
        }
        if health_check(address) && desktop_capability_check(address, desktop_capability) {
            if let Some(status) = child.try_wait()? {
                return Err(format!("Office Server exited during startup ({status}).").into());
            }
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
    let mut response = Vec::new();
    let read_result = stream
        .take(MAX_HEALTH_RESPONSE + 1)
        .read_to_end(&mut response);
    if read_result.is_err() || response.len() as u64 > MAX_HEALTH_RESPONSE {
        return false;
    }
    let text = match String::from_utf8(response) {
        Ok(value) => value,
        Err(_) => return false,
    };
    let Some((headers, body)) = text.split_once("\r\n\r\n") else {
        return false;
    };
    http_status_is_ok(headers) && health_body_is_compatible(body)
}

fn http_status_is_ok(headers: &str) -> bool {
    let mut tokens = headers.split_whitespace();
    let Some(version) = tokens.next() else {
        return false;
    };
    if version != "HTTP/1.1" && version != "HTTP/1.0" {
        return false;
    }
    let Some(status) = tokens.next() else {
        return false;
    };
    status == "200"
}

fn desktop_capability_check(address: SocketAddr, desktop_capability: &str) -> bool {
    let Ok(mut stream) = TcpStream::connect_timeout(&address, Duration::from_millis(200)) else {
        return false;
    };
    let timeout = Some(Duration::from_millis(500));
    if stream.set_read_timeout(timeout).is_err() || stream.set_write_timeout(timeout).is_err() {
        return false;
    }
    let request = format!(
        "GET /api/v1/host/remote HTTP/1.1\r\nHost: {OFFICE_HOST}:{OFFICE_PORT}\r\n{DESKTOP_CAPABILITY_HEADER}: {desktop_capability}\r\nConnection: close\r\n\r\n"
    );
    if stream.write_all(request.as_bytes()).is_err() {
        return false;
    }
    let mut buffer = [0_u8; 512];
    let mut total = 0_usize;
    let mut response = Vec::new();
    let mut found_headers = false;
    loop {
        let Ok(size) = stream.read(&mut buffer) else {
            return false;
        };
        if size == 0 {
            break;
        }
        total += size;
        if total > MAX_HTTP_HEADERS {
            return false;
        }
        response.extend_from_slice(&buffer[..size]);
        if response.windows(4).any(|window| window == b"\r\n\r\n") {
            found_headers = true;
            break;
        }
    }
    if !found_headers {
        return false;
    }
    let text = match String::from_utf8(response) {
        Ok(value) => value,
        Err(_) => return false,
    };
    http_status_is_ok(&text)
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum HealthCompatibility {
    Compatible,
    Incompatible,
    Malformed,
}

fn health_body_is_compatible(body: &str) -> bool {
    classify_health_body(body) == HealthCompatibility::Compatible
}

fn classify_health_body(body: &str) -> HealthCompatibility {
    let value: serde_json::Value = match serde_json::from_str(body) {
        Ok(value) => value,
        Err(_) => return HealthCompatibility::Malformed,
    };
    if value.get("ok").and_then(|ok| ok.as_bool()) != Some(true) {
        return HealthCompatibility::Malformed;
    }
    let runtime_is_valid = matches!(
        value.get("runtime").and_then(|runtime| runtime.as_str()),
        Some(
            "unconfigured"
                | "starting"
                | "ready"
                | "stopping"
                | "stopped"
                | "unreachable"
                | "incompatible"
                | "error"
        )
    );
    if !runtime_is_valid {
        return HealthCompatibility::Malformed;
    }
    let version = match value.get("protocolVersion") {
        Some(version) => version,
        None => return HealthCompatibility::Malformed,
    };
    match version.as_i64() {
        Some(v) if v == OFFICE_PROTOCOL_VERSION => HealthCompatibility::Compatible,
        Some(_) => HealthCompatibility::Incompatible,
        None => HealthCompatibility::Malformed,
    }
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
    fn http_status_is_ok_only_for_exact_200() {
        assert!(http_status_is_ok("HTTP/1.1 200 OK"));
        assert!(http_status_is_ok("HTTP/1.0 200"));
        assert!(!http_status_is_ok("HTTP/1.1 2000"));
        assert!(!http_status_is_ok("HTTP/1.1 403 Forbidden"));
        assert!(!http_status_is_ok("malformed"));
    }

    #[test]
    fn health_body_compatibility_requires_the_office_health_contract() {
        assert!(health_body_is_compatible(
            r#"{"ok":true,"protocolVersion":1,"runtime":"ready"}"#
        ));
        assert!(health_body_is_compatible(
            r#"{"ok":true,"protocolVersion":1,"runtime":"unconfigured","details":{}}"#
        ));
        assert!(!health_body_is_compatible(
            r#"{"ok":true,"protocolVersion":2,"runtime":"ready"}"#
        ));
        assert!(!health_body_is_compatible(r#"{"protocolVersion":1}"#));
        assert!(!health_body_is_compatible("not-json"));
    }

    #[test]
    fn health_body_classifies_malformed_contract_and_nonnumeric_version() {
        assert_eq!(
            classify_health_body("not-json"),
            HealthCompatibility::Malformed
        );
        assert_eq!(
            classify_health_body(r#"{"protocolVersion":1}"#),
            HealthCompatibility::Malformed
        );
        assert_eq!(
            classify_health_body(r#"{"ok":false,"protocolVersion":1,"runtime":"ready"}"#),
            HealthCompatibility::Malformed
        );
        assert_eq!(
            classify_health_body(r#"{"ok":true,"protocolVersion":1}"#),
            HealthCompatibility::Malformed
        );
        assert_eq!(
            classify_health_body(r#"{"ok":true,"protocolVersion":1,"runtime":"other"}"#),
            HealthCompatibility::Malformed
        );
        assert_eq!(
            classify_health_body(r#"{"ok":true,"protocolVersion":"1","runtime":"ready"}"#),
            HealthCompatibility::Malformed
        );
        assert_eq!(
            classify_health_body(r#"{"ok":true,"protocolVersion":null,"runtime":"ready"}"#),
            HealthCompatibility::Malformed
        );
        assert_eq!(
            classify_health_body(r#"{"ok":true,"protocolVersion":1.1,"runtime":"ready"}"#),
            HealthCompatibility::Malformed
        );
        assert_eq!(
            classify_health_body(r#"{"ok":true,"protocolVersion":1,"runtime":"ready"}"#),
            HealthCompatibility::Compatible
        );
        assert_eq!(
            classify_health_body(r#"{"ok":true,"protocolVersion":2,"runtime":"ready"}"#),
            HealthCompatibility::Incompatible
        );
    }

    #[test]
    fn classify_free_port_allows_startup() {
        let address = SocketAddr::from((Ipv4Addr::LOCALHOST, 0));
        let listener = TcpListener::bind(address).expect("bind temporary port");
        let actual = listener.local_addr().expect("local address");
        drop(listener);

        assert_eq!(
            classify_office_startup(actual).expect("free port should classify"),
            OfficeStartup::PortFree
        );
    }

    #[test]
    fn classify_compatible_existing_server_attaches() {
        let address = bind_health_server(
            "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\n\r\n{\"ok\":true,\"protocolVersion\":1,\"runtime\":\"ready\"}",
        );
        assert_eq!(
            classify_office_startup(address).expect("compatible server should classify"),
            OfficeStartup::AttachExisting
        );
    }

    #[test]
    fn classify_listener_with_only_protocol_version_rejects() {
        let address = bind_health_server(
            "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\n\r\n{\"protocolVersion\":1}",
        );
        let error = classify_office_startup(address)
            .expect_err("an incomplete health contract must not be treated as Office Server");
        assert!(error.to_string().contains("malformed"));
    }

    #[test]
    fn classify_incompatible_existing_server_rejects() {
        let address = bind_health_server(
            "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\n\r\n{\"ok\":true,\"protocolVersion\":2,\"runtime\":\"ready\"}",
        );
        let error = classify_office_startup(address).expect_err("incompatible server should error");
        assert!(error.to_string().contains("incompatible protocol version"));
    }

    #[test]
    fn classify_malformed_health_response_rejects() {
        let address =
            bind_health_server("HTTP/1.1 200 OK\r\nContent-Type: text/plain\r\n\r\nnot-json");
        let error = classify_office_startup(address).expect_err("malformed health should error");
        assert!(error.to_string().contains("malformed"));
    }

    #[test]
    fn classify_nonnumeric_protocol_version_rejects_malformed() {
        let address = bind_health_server(
            "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\n\r\n{\"ok\":true,\"protocolVersion\":\"1\",\"runtime\":\"ready\"}",
        );
        let error = classify_office_startup(address).expect_err("nonnumeric version should error");
        assert!(error.to_string().contains("malformed"));
    }

    #[test]
    fn classify_other_service_rejects() {
        let address = bind_health_server(
            "HTTP/1.1 404 Not Found\r\nContent-Type: text/plain\r\n\r\nnot found",
        );
        let error = classify_office_startup(address).expect_err("other service should error");
        assert!(error.to_string().contains("non-Hermes Office service"));
    }

    fn bind_health_server(response: &'static str) -> SocketAddr {
        let listener = TcpListener::bind(SocketAddr::from((Ipv4Addr::LOCALHOST, 0)))
            .expect("bind temporary health server");
        let address = listener.local_addr().expect("local address");
        thread::spawn(move || {
            let (mut stream, _) = listener.accept().expect("accept health connection");
            let _ = stream.write_all(response.as_bytes());
            let _ = stream.shutdown(std::net::Shutdown::Both);
        });
        address
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

    #[test]
    fn classify_stalling_health_response_is_timeout() {
        let listener = TcpListener::bind(SocketAddr::from((Ipv4Addr::LOCALHOST, 0)))
            .expect("bind temporary health server");
        let address = listener.local_addr().expect("local address");
        thread::spawn(move || {
            let (mut stream, _) = listener.accept().expect("accept health connection");
            // Read the request so the client finishes writing, then remain silent
            // long enough for the client-side 500 ms read timeout to fire.
            let mut buffer = [0_u8; 512];
            let _ = stream.read(&mut buffer);
            thread::sleep(Duration::from_millis(800));
        });
        let error = classify_office_startup(address).expect_err("stalling server should error");
        assert!(error.to_string().contains("timed out"));
    }
}
