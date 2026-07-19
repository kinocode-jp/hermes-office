use std::{
    env,
    ffi::OsString,
    io::{Read, Write},
    net::{Ipv4Addr, SocketAddr, TcpListener, TcpStream},
    path::{Path, PathBuf},
    process::{Child, Command, ExitStatus, Stdio},
    sync::Mutex,
    thread,
    time::{Duration, Instant},
};
use hmac::{Hmac, Mac};
use sha2::Sha256;
use tauri::{Manager, RunEvent};

const OFFICE_HOST: &str = "127.0.0.1";
const OFFICE_PORT: u16 = 4317;
const OFFICE_URL: &str = "http://127.0.0.1:4317/";
const OFFICE_PROTOCOL_VERSION: i64 = 1;
const START_TIMEOUT: Duration = Duration::from_secs(50);
const STOP_TIMEOUT: Duration = Duration::from_secs(5);
const VERSION_TIMEOUT: Duration = Duration::from_secs(3);
const HEALTH_RESPONSE_TIMEOUT: Duration = Duration::from_millis(750);
const OWNED_SERVER_MONITOR_INTERVAL: Duration = Duration::from_millis(250);
const OWNED_SERVER_TRANSIENT_FAILURE_LIMIT: u8 = 3;
const HTTP_READ_SLICE: Duration = Duration::from_millis(250);
const CHILD_POLL_INTERVAL: Duration = Duration::from_millis(20);
const MAX_VERSION_OUTPUT: u64 = 4096;
const MAX_HTTP_HEADERS: usize = 8192;
const MAX_HEALTH_RESPONSE: u64 = 4096;
const MAX_WEB_UI_RESPONSE: usize = 128 * 1024;
const DESKTOP_PROOF_DOMAIN: &str = "hermes-office-desktop-readiness";
const DESKTOP_PROOF_VERSION: &str = "1";
const DESKTOP_PROOF_NONCE_BYTES: usize = 32;
const SUPPORTED_NODE_MAJOR: u64 = 22;
const SUPPORTED_HERMES_MAJOR: u64 = 0;
const SUPPORTED_HERMES_MINOR: u64 = 18;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum OfficeStartup {
    /// Loopback port is free; this desktop instance should start and own the
    /// Office Server child.
    PortFree,
    /// A listener with the expected protocol and Web UI shape is already on
    /// the port. These public responses do not authenticate its identity.
    CompatibleCandidate,
}

#[derive(Debug, Clone, PartialEq, Eq)]
enum StartupProbeError {
    Incompatible,
    Malformed,
    Timeout,
    OtherService,
    ExistingWebUiUnavailable,
    ExistingWebUiTimeout,
}
impl std::fmt::Display for StartupProbeError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            StartupProbeError::Incompatible => {
                write!(formatter, "A listener on port {OFFICE_PORT} returned an Office-shaped health response with an incompatible protocol version. Verify the port owner before closing or updating it.")
            }
            StartupProbeError::Malformed => {
                write!(formatter, "A listener on port {OFFICE_PORT} returned a malformed health response. Verify the port owner before inspecting or closing it.")
            }
            StartupProbeError::Timeout => {
                write!(formatter, "A listener on port {OFFICE_PORT} did not complete the health probe in time. Verify the port owner before inspecting or closing it.")
            }
            StartupProbeError::OtherService => {
                write!(formatter, "Port {OFFICE_PORT} is already in use by a service that was not recognized as Hermes Office. Verify the port owner before inspecting or closing it.")
            }
            StartupProbeError::ExistingWebUiUnavailable => {
                write!(formatter, "A listener on port {OFFICE_PORT} returned the compatible health shape but not the expected Hermes Office Web UI shape. Verify the port owner before changing that service.")
            }
            StartupProbeError::ExistingWebUiTimeout => {
                write!(formatter, "A listener on port {OFFICE_PORT} returned the compatible health shape, but its Web UI probe timed out. Verify the port owner before changing that service.")
            }
        }
    }
}

impl std::error::Error for StartupProbeError {}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum StartupNoticeKind {
    ExistingServerCandidate,
    ExistingServerIncompatible,
    ExistingServerMalformed,
    ExistingServerTimeout,
    PortUsedByOtherService,
    ExistingWebUiUnavailable,
    ExistingWebUiTimeout,
    OwnedManagedRuntimeUnavailable,
    OwnedBundledResourceUnavailable,
    OwnedChildLaunchFailed,
    OwnedServerReadinessFailed,
    InternalStateUnavailable,
}

impl From<StartupProbeError> for StartupNoticeKind {
    fn from(error: StartupProbeError) -> Self {
        match error {
            StartupProbeError::Incompatible => Self::ExistingServerIncompatible,
            StartupProbeError::Malformed => Self::ExistingServerMalformed,
            StartupProbeError::Timeout => Self::ExistingServerTimeout,
            StartupProbeError::OtherService => Self::PortUsedByOtherService,
            StartupProbeError::ExistingWebUiUnavailable => Self::ExistingWebUiUnavailable,
            StartupProbeError::ExistingWebUiTimeout => Self::ExistingWebUiTimeout,
        }
    }
}

impl StartupNoticeKind {
    fn explanation(self) -> &'static str {
        match self {
            Self::ExistingServerCandidate => {
                "A listener on port 4317 has the expected Hermes Office protocol and Web UI shape, but those public responses do not verify its identity. Nothing was opened automatically."
            }
            Self::ExistingServerIncompatible => {
                "The listener on port 4317 returned an Office-shaped health response, but its protocol version is not compatible with this desktop launcher. This does not authenticate the listener."
            }
            Self::ExistingServerMalformed => {
                "The listener on port 4317 returned an invalid health response and has not been authenticated as Hermes Office."
            }
            Self::ExistingServerTimeout => {
                "The listener on port 4317 did not complete the health probe in time and has not been authenticated as Hermes Office."
            }
            Self::PortUsedByOtherService => {
                "Port 4317 is occupied by a service that could not be verified as Hermes Office."
            }
            Self::ExistingWebUiUnavailable => {
                "The listener on port 4317 returned the compatible health shape but is not serving the expected Web UI shape from /. Its identity is not authenticated."
            }
            Self::ExistingWebUiTimeout => {
                "The listener on port 4317 returned the compatible health shape, but its Web UI probe did not respond in time. Its identity is not authenticated."
            }
            Self::OwnedManagedRuntimeUnavailable => {
                "The desktop launcher could not find or validate the managed Node.js and Hermes Agent runtimes required to start its Office server."
            }
            Self::OwnedBundledResourceUnavailable => {
                "The desktop launcher could not locate the bundled Office server resources required to start its own server."
            }
            Self::OwnedChildLaunchFailed => {
                "The desktop launcher found its runtime and resources, but could not launch its Office server process."
            }
            Self::OwnedServerReadinessFailed => {
                "The desktop launcher started its Office server process, but the server exited early or did not become ready in time."
            }
            Self::InternalStateUnavailable => {
                "The desktop launcher could not safely update its internal ownership state."
            }
        }
    }

    fn recovery_steps(self) -> &'static [&'static str] {
        match self {
            Self::ExistingServerCandidate => &[
                "First confirm that the process which owns loopback port 4317 is your Hermes Office server.",
                "Only after confirming the owner, manually open http://127.0.0.1:4317/ in a normal browser.",
                "If the owner is unknown, do not open the URL. Inspect or stop that process through its normal management procedure; Hermes Office will not kill it automatically.",
            ],
            Self::PortUsedByOtherService => &[
                "Check which application owns loopback port 4317.",
                "If that application is not needed, close it normally, then start Hermes Office again. Do not force-kill an unknown process.",
            ],
            Self::ExistingServerIncompatible => &[
                "First verify that the process owning loopback port 4317 is your Hermes Office server.",
                "After verification, update it to a version compatible with this desktop launcher, or close it normally.",
                "Start the desktop launcher again after the compatible server is ready or port 4317 is free.",
            ],
            Self::ExistingServerMalformed => &[
                "First verify which process owns loopback port 4317.",
                "Inspect the existing listener and its logs because its Hermes Office health response is invalid.",
                "Restart that service normally, or close it and start a compatible Hermes Office server before retrying.",
            ],
            Self::ExistingServerTimeout => &[
                "First verify which process owns loopback port 4317.",
                "Inspect the existing listener and its logs because its Hermes Office health check timed out.",
                "Restart that service normally, then retry after it responds on port 4317.",
            ],
            Self::ExistingWebUiUnavailable => &[
                "First verify that the process owning loopback port 4317 is your Hermes Office server.",
                "For development, run the normal combined development surface so the server and Web UI start together.",
                "For a packaged or local production setup, build the web assets and serve them from / on the same port 4317 listener.",
                "Only after verifying the owner and making the Web UI available, manually open http://127.0.0.1:4317/ in a normal browser.",
            ],
            Self::ExistingWebUiTimeout => &[
                "First verify which process owns loopback port 4317.",
                "Inspect the existing listener and its logs because its Web UI response timed out.",
                "Restart that service normally, then retry after the Web UI responds on port 4317.",
            ],
            Self::OwnedManagedRuntimeUnavailable => &[
                "Confirm that the supported managed Node.js and Hermes Agent runtimes are installed and available to Hermes Office.",
                "Repair or reinstall the managed runtime, then start Hermes Office again.",
            ],
            Self::OwnedBundledResourceUnavailable => &[
                "Reinstall Hermes Office from a complete application bundle so its server resources are restored.",
                "If this is a development checkout, restore its required development files and dependencies before retrying.",
            ],
            Self::OwnedChildLaunchFailed => &[
                "Confirm the managed runtime and installed Hermes Office bundle are readable and allowed to launch processes.",
                "Restart Hermes Office; if it still fails, reinstall the application and its managed runtime.",
            ],
            Self::OwnedServerReadinessFailed => &[
                "Close Hermes Office normally, then start it again.",
                "If the failure continues, check which application owns loopback port 4317 and confirm the port is free before retrying.",
                "Repair or reinstall the managed runtime or Hermes Office application bundle if the server still does not become ready.",
            ],
            Self::InternalStateUnavailable => &[
                "Close Hermes Office normally and start it again.",
                "If the problem continues, reinstall the application; do not manually stop unrelated processes.",
            ],
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum OwnedServerLaunchError {
    ManagedRuntimeUnavailable,
    BundledResourceUnavailable,
    ChildLaunchFailed,
}

impl From<OwnedServerLaunchError> for StartupNoticeKind {
    fn from(error: OwnedServerLaunchError) -> Self {
        match error {
            OwnedServerLaunchError::ManagedRuntimeUnavailable => {
                Self::OwnedManagedRuntimeUnavailable
            }
            OwnedServerLaunchError::BundledResourceUnavailable => {
                Self::OwnedBundledResourceUnavailable
            }
            OwnedServerLaunchError::ChildLaunchFailed => Self::OwnedChildLaunchFailed,
        }
    }
}

struct OfficeServerProcess(Mutex<Option<Child>>);
struct DesktopCapability(Mutex<Option<String>>);
struct DesktopProofGate(Mutex<()>);

#[tauri::command]
async fn desktop_capability(app: tauri::AppHandle) -> Option<String> {
    let worker_app = app.clone();
    let outcome = tauri::async_runtime::spawn_blocking(move || {
        authenticated_owned_capability(&worker_app)
    })
    .await
    .unwrap_or(OwnedCapabilityOutcome::TransientUnavailable);
    match outcome {
        OwnedCapabilityOutcome::Valid(capability) => Some(capability),
        OwnedCapabilityOutcome::Invalid => {
            invalidate_owned_desktop(&app);
            None
        }
        OwnedCapabilityOutcome::TransientUnavailable => None,
    }
}

#[tauri::command]
async fn desktop_owned(app: tauri::AppHandle) -> bool {
    let worker_app = app.clone();
    let outcome = tauri::async_runtime::spawn_blocking(move || {
        authenticated_owned_capability(&worker_app)
    })
    .await
    .unwrap_or(OwnedCapabilityOutcome::TransientUnavailable);
    match outcome {
        OwnedCapabilityOutcome::Valid(_) => true,
        OwnedCapabilityOutcome::Invalid => {
            invalidate_owned_desktop(&app);
            false
        }
        OwnedCapabilityOutcome::TransientUnavailable => false,
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let app = tauri::Builder::default()
        .manage(OfficeServerProcess(Mutex::new(None)))
        .manage(DesktopCapability(Mutex::new(None)))
        .manage(DesktopProofGate(Mutex::new(())))
        .invoke_handler(tauri::generate_handler![desktop_capability, desktop_owned])
        .setup(|app| {
            // `main` has `create: false` in tauri.conf.json. Do not create a
            // WebView, and therefore do not load the app bundle, until the
            // loopback listener has been classified and an owned child has
            // completed its capability-keyed HMAC readiness proof.
            // The desktop shell starts its own Office Server only when the port
            // is free. An existing listener is never trusted based only on its
            // public responses, navigated to, stopped, or killed automatically.
            let notice = setup_office(app).err();
            if let Err(error) = build_main_window(app, notice) {
                // Window creation happens after an owned child is ready. If the
                // native window cannot be created, do not orphan that child
                // while the outer application build exits gracefully.
                if let Ok(mut process) = app.state::<OfficeServerProcess>().0.lock() {
                    if let Some(mut child) = process.take() {
                        stop_office_server(&mut child);
                    }
                }
                return Err(error);
            }
            if notice.is_none() {
                start_owned_server_monitor(app.handle().clone());
            }
            Ok(())
        })
        .build(tauri::generate_context!());

    let app = match app {
        Ok(app) => app,
        Err(error) => {
            eprintln!("Hermes Office could not start safely: {error}");
            return;
        }
    };

    app.run(|handle, event| {
        if matches!(event, RunEvent::ExitRequested { .. } | RunEvent::Exit) {
            if let Ok(mut capability) = handle.state::<DesktopCapability>().0.lock() {
                *capability = None;
            }
            if let Ok(mut process) = handle.state::<OfficeServerProcess>().0.lock() {
                if let Some(mut child) = process.take() {
                    stop_office_server(&mut child);
                }
            }
        }
    });
}

fn setup_office(app: &tauri::App) -> Result<(), StartupNoticeKind> {
    let address = SocketAddr::from((Ipv4Addr::LOCALHOST, OFFICE_PORT));
    match classify_office_startup(address).map_err(StartupNoticeKind::from)? {
        OfficeStartup::PortFree => {
            let desktop_capability = generate_desktop_capability();
            #[cfg(debug_assertions)]
            let mut child = start_office_dev_server(app, &desktop_capability)
                .map_err(StartupNoticeKind::from)?;
            #[cfg(not(debug_assertions))]
            let mut child = start_office_server(app, &desktop_capability)
                .map_err(StartupNoticeKind::from)?;
            if wait_for_office_server(&mut child, START_TIMEOUT, &desktop_capability).is_err() {
                stop_office_server(&mut child);
                return Err(StartupNoticeKind::OwnedServerReadinessFailed);
            }
            let process_state = app.state::<OfficeServerProcess>();
            let capability_state = app.state::<DesktopCapability>();
            let mut capability = match capability_state.0.lock() {
                Ok(capability) => capability,
                Err(_) => {
                    stop_office_server(&mut child);
                    return Err(StartupNoticeKind::InternalStateUnavailable);
                }
            };
            let mut process = match process_state.0.lock() {
                Ok(process) => process,
                Err(_) => {
                    stop_office_server(&mut child);
                    return Err(StartupNoticeKind::InternalStateUnavailable);
                }
            };
            *process = Some(child);
            *capability = Some(desktop_capability);
            Ok(())
        }
        OfficeStartup::CompatibleCandidate => Err(StartupNoticeKind::ExistingServerCandidate),
    }
}

enum OwnedCapabilityOutcome {
    Valid(String),
    Invalid,
    TransientUnavailable,
}

fn authenticated_owned_capability(app: &tauri::AppHandle) -> OwnedCapabilityOutcome {
    let Ok(_proof_gate) = app.state::<DesktopProofGate>().0.lock() else {
        return OwnedCapabilityOutcome::Invalid;
    };
    let capability = match app.state::<DesktopCapability>().0.lock() {
        Ok(capability) => match capability.clone() {
            Some(capability) => capability,
            None => return OwnedCapabilityOutcome::Invalid,
        },
        Err(_) => return OwnedCapabilityOutcome::Invalid,
    };
    match owned_child_outcome(app) {
        OwnedChildOutcome::Running => {}
        OwnedChildOutcome::Exited | OwnedChildOutcome::InvalidState => {
            clear_desktop_capability(app);
            return OwnedCapabilityOutcome::Invalid;
        }
        OwnedChildOutcome::TransientUnavailable => {
            return OwnedCapabilityOutcome::TransientUnavailable;
        }
    }
    let address = SocketAddr::from((Ipv4Addr::LOCALHOST, OFFICE_PORT));
    match desktop_readiness_proof_outcome(
        address,
        &capability,
        Instant::now() + HEALTH_RESPONSE_TIMEOUT,
    ) {
        DesktopProofOutcome::Valid => {}
        DesktopProofOutcome::Invalid => {
            clear_desktop_capability(app);
            return OwnedCapabilityOutcome::Invalid;
        }
        DesktopProofOutcome::TransientUnavailable => {
            return OwnedCapabilityOutcome::TransientUnavailable;
        }
    }
    match owned_child_outcome(app) {
        OwnedChildOutcome::Running => {}
        OwnedChildOutcome::Exited | OwnedChildOutcome::InvalidState => {
            clear_desktop_capability(app);
            return OwnedCapabilityOutcome::Invalid;
        }
        OwnedChildOutcome::TransientUnavailable => {
            return OwnedCapabilityOutcome::TransientUnavailable;
        }
    }
    let Ok(current) = app.state::<DesktopCapability>().0.lock() else {
        return OwnedCapabilityOutcome::Invalid;
    };
    if current.as_deref() == Some(capability.as_str()) {
        OwnedCapabilityOutcome::Valid(capability)
    } else {
        OwnedCapabilityOutcome::Invalid
    }
}

fn clear_desktop_capability(app: &tauri::AppHandle) {
    if let Ok(mut capability) = app.state::<DesktopCapability>().0.lock() {
        *capability = None;
    }
}

enum OwnedChildOutcome {
    Running,
    Exited,
    TransientUnavailable,
    InvalidState,
}

fn owned_child_outcome(app: &tauri::AppHandle) -> OwnedChildOutcome {
    let Ok(mut process) = app.state::<OfficeServerProcess>().0.lock() else {
        return OwnedChildOutcome::InvalidState;
    };
    let Some(child) = process.as_mut() else {
        return OwnedChildOutcome::Exited;
    };
    match child.try_wait() {
        Ok(None) => OwnedChildOutcome::Running,
        Ok(Some(_)) => OwnedChildOutcome::Exited,
        Err(_) => OwnedChildOutcome::TransientUnavailable,
    }
}

fn invalidate_owned_desktop(app: &tauri::AppHandle) {
    clear_desktop_capability(app);
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.close();
    }
}

fn monitor_outcome_requires_invalidation(
    outcome: &OwnedCapabilityOutcome,
    consecutive_transient_failures: &mut u8,
) -> bool {
    match outcome {
        OwnedCapabilityOutcome::Valid(_) => {
            *consecutive_transient_failures = 0;
            false
        }
        OwnedCapabilityOutcome::Invalid => true,
        OwnedCapabilityOutcome::TransientUnavailable => {
            *consecutive_transient_failures =
                (*consecutive_transient_failures).saturating_add(1);
            *consecutive_transient_failures >= OWNED_SERVER_TRANSIENT_FAILURE_LIMIT
        }
    }
}

fn start_owned_server_monitor(app: tauri::AppHandle) {
    thread::spawn(move || {
        let mut consecutive_transient_failures = 0_u8;
        loop {
            thread::sleep(OWNED_SERVER_MONITOR_INTERVAL);
            let still_owned = app
                .state::<DesktopCapability>()
                .0
                .lock()
                .ok()
                .is_some_and(|capability| capability.is_some());
            if !still_owned {
                return;
            }
            let outcome = authenticated_owned_capability(&app);
            if monitor_outcome_requires_invalidation(
                &outcome,
                &mut consecutive_transient_failures,
            ) {
                invalidate_owned_desktop(&app);
                return;
            }
        }
    });
}

fn build_main_window(
    app: &tauri::App,
    notice: Option<StartupNoticeKind>,
) -> Result<(), Box<dyn std::error::Error>> {
    let main_config = app
        .config()
        .app
        .windows
        .iter()
        .find(|config| config.label == "main")
        .ok_or("Hermes Office main window configuration is unavailable")?;
    let mut window_config = main_config.clone();
    window_config.url = startup_window_url(&main_config.url, notice)?;
    tauri::WebviewWindowBuilder::from_config(app, &window_config)?.build()?;
    Ok(())
}

fn startup_window_url(
    app_url: &tauri::WebviewUrl,
    notice: Option<StartupNoticeKind>,
) -> Result<tauri::WebviewUrl, Box<dyn std::error::Error>> {
    match notice {
        Some(notice) => Ok(tauri::WebviewUrl::CustomProtocol(tauri::Url::parse(
            &startup_notice_data_url(notice),
        )?)),
        None => Ok(app_url.clone()),
    }
}

fn startup_notice_html(notice: StartupNoticeKind) -> String {
    let title = html_escape("Hermes Office needs attention");
    let explanation = html_escape(notice.explanation());
    let recovery_steps = notice
        .recovery_steps()
        .iter()
        .map(|step| format!("<li>{}</li>", html_escape(step)))
        .collect::<String>();
    format!(
        "<!doctype html><html lang=\"en\"><head><meta charset=\"utf-8\"><meta name=\"viewport\" content=\"width=device-width,initial-scale=1\"><title>{title}</title><style>html{{color-scheme:light dark}}body{{margin:0;min-height:100vh;display:grid;place-items:center;font:16px/1.55 system-ui,-apple-system,sans-serif;background:#111827;color:#f8fafc}}main{{box-sizing:border-box;width:min(680px,calc(100% - 40px));padding:32px;border:1px solid #374151;border-radius:16px;background:#1f2937}}h1{{margin:0 0 16px;font-size:26px}}p,ol{{margin:12px 0}}li+li{{margin-top:8px}}</style></head><body><main><h1>{title}</h1><p>{explanation}</p><p>No external server or process was stopped or replaced.</p><ol>{recovery_steps}</ol></main></body></html>"
    )
}

fn html_escape(value: &str) -> String {
    let mut escaped = String::with_capacity(value.len());
    for character in value.chars() {
        match character {
            '&' => escaped.push_str("&amp;"),
            '<' => escaped.push_str("&lt;"),
            '>' => escaped.push_str("&gt;"),
            '"' => escaped.push_str("&quot;"),
            '\'' => escaped.push_str("&#39;"),
            _ => escaped.push(character),
        }
    }
    escaped
}

fn percent_encode_data(value: &str) -> String {
    let mut encoded = String::with_capacity(value.len() * 3);
    for byte in value.bytes() {
        if byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'.' | b'_' | b'~') {
            encoded.push(char::from(byte));
        } else {
            use std::fmt::Write as _;
            write!(&mut encoded, "%{byte:02X}").expect("writing to a String cannot fail");
        }
    }
    encoded
}

fn startup_notice_data_url(notice: StartupNoticeKind) -> String {
    format!(
        "data:text/html;charset=utf-8,{}",
        percent_encode_data(&startup_notice_html(notice))
    )
}

fn start_office_server(
    app: &tauri::App,
    desktop_capability: &str,
) -> Result<Child, OwnedServerLaunchError> {
    let resource_dir = app
        .path()
        .resource_dir()
        .map_err(|_| OwnedServerLaunchError::BundledResourceUnavailable)?;
    let script = resource_dir.join("resources/server/hermes-office-server.mjs");
    if !script.is_file() {
        return Err(OwnedServerLaunchError::BundledResourceUnavailable);
    }

    let (node, hermes) = resolve_managed_runtime()
        .map_err(|_| OwnedServerLaunchError::ManagedRuntimeUnavailable)?;

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
    command
        .spawn()
        .map_err(|_| OwnedServerLaunchError::ChildLaunchFailed)
}

#[cfg(debug_assertions)]
fn start_office_dev_server(
    app: &tauri::App,
    desktop_capability: &str,
) -> Result<Child, OwnedServerLaunchError> {
    let repo_root = resolve_repo_root()
        .map_err(|_| OwnedServerLaunchError::BundledResourceUnavailable)?;
    let (node, hermes) = resolve_managed_runtime()
        .map_err(|_| OwnedServerLaunchError::ManagedRuntimeUnavailable)?;
    let tsx = resolve_tsx_cli(&repo_root)
        .map_err(|_| OwnedServerLaunchError::BundledResourceUnavailable)?;

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
    command
        .spawn()
        .map_err(|_| OwnedServerLaunchError::ChildLaunchFailed)
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
    random_hex::<32>()
}

fn random_hex<const N: usize>() -> String {
    let mut bytes = [0_u8; N];
    getrandom::fill(&mut bytes).expect("operating system random source is unavailable");
    encode_lower_hex(&bytes)
}

fn encode_lower_hex(bytes: &[u8]) -> String {
    let mut encoded = String::with_capacity(bytes.len() * 2);
    for byte in bytes {
        use std::fmt::Write as _;
        write!(&mut encoded, "{byte:02x}").expect("writing to a String cannot fail");
    }
    encoded
}

fn classify_office_startup(
    address: SocketAddr,
) -> Result<OfficeStartup, StartupProbeError> {
    if let Ok(listener) = TcpListener::bind(address) {
        drop(listener);
        return Ok(OfficeStartup::PortFree);
    }

    match probe_existing_health(address) {
        ProbeOutcome::Compatible => match probe_existing_web_ui(address) {
            WebUiProbeOutcome::Compatible => Ok(OfficeStartup::CompatibleCandidate),
            WebUiProbeOutcome::Unavailable => {
                Err(StartupProbeError::ExistingWebUiUnavailable)
            }
            WebUiProbeOutcome::Timeout => Err(StartupProbeError::ExistingWebUiTimeout),
        },
        ProbeOutcome::Incompatible => Err(StartupProbeError::Incompatible),
        ProbeOutcome::Malformed => Err(StartupProbeError::Malformed),
        ProbeOutcome::Timeout => Err(StartupProbeError::Timeout),
        ProbeOutcome::OtherService => Err(StartupProbeError::OtherService),
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum WebUiProbeOutcome {
    Compatible,
    Unavailable,
    Timeout,
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
    let deadline = Instant::now() + HEALTH_RESPONSE_TIMEOUT;
    let mut stream = match TcpStream::connect_timeout(&address, Duration::from_millis(200)) {
        Ok(stream) => stream,
        Err(error)
            if matches!(
                error.kind(),
                std::io::ErrorKind::WouldBlock | std::io::ErrorKind::TimedOut
            ) =>
        {
            return ProbeOutcome::Timeout;
        }
        Err(_) => return ProbeOutcome::OtherService,
    };
    if set_write_timeout_until(&stream, deadline).is_err() {
        return ProbeOutcome::Timeout;
    }
    let host = format!("{address}");
    let request =
        format!("GET /api/v1/health HTTP/1.1\r\nHost: {host}\r\nConnection: close\r\n\r\n");
    if let Err(error) = stream.write_all(request.as_bytes()) {
        return if matches!(
            error.kind(),
            std::io::ErrorKind::WouldBlock | std::io::ErrorKind::TimedOut
        ) {
            ProbeOutcome::Timeout
        } else {
            ProbeOutcome::OtherService
        };
    }
    let response =
        match read_bounded_response(&mut stream, MAX_HEALTH_RESPONSE as usize, deadline, false) {
            Ok(response) => response,
            Err(BoundedReadError::Timeout) => return ProbeOutcome::Timeout,
            Err(BoundedReadError::LimitExceeded | BoundedReadError::Io) => {
                return ProbeOutcome::Malformed;
            }
        };
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

fn probe_existing_web_ui(address: SocketAddr) -> WebUiProbeOutcome {
    let deadline = Instant::now() + HEALTH_RESPONSE_TIMEOUT;
    let Some(connect_timeout) = remaining_timeout(deadline, Duration::from_millis(200)) else {
        return WebUiProbeOutcome::Timeout;
    };
    let mut stream = match TcpStream::connect_timeout(&address, connect_timeout) {
        Ok(stream) => stream,
        Err(error)
            if matches!(
                error.kind(),
                std::io::ErrorKind::WouldBlock | std::io::ErrorKind::TimedOut
            ) =>
        {
            return WebUiProbeOutcome::Timeout;
        }
        Err(_) => return WebUiProbeOutcome::Unavailable,
    };
    if set_write_timeout_until(&stream, deadline).is_err() {
        return WebUiProbeOutcome::Timeout;
    }
    let request = format!(
        "GET / HTTP/1.1\r\nHost: {address}\r\nAccept: text/html\r\nConnection: close\r\n\r\n"
    );
    if let Err(error) = stream.write_all(request.as_bytes()) {
        return if matches!(
            error.kind(),
            std::io::ErrorKind::WouldBlock | std::io::ErrorKind::TimedOut
        ) {
            WebUiProbeOutcome::Timeout
        } else {
            WebUiProbeOutcome::Unavailable
        };
    }
    let response = match read_bounded_response(&mut stream, MAX_WEB_UI_RESPONSE, deadline, false) {
        Ok(response) => response,
        Err(BoundedReadError::Timeout) => return WebUiProbeOutcome::Timeout,
        Err(BoundedReadError::LimitExceeded | BoundedReadError::Io) => {
            return WebUiProbeOutcome::Unavailable;
        }
    };
    let text = match String::from_utf8(response) {
        Ok(value) => value,
        Err(_) => return WebUiProbeOutcome::Unavailable,
    };
    let Some((headers, body)) = text.split_once("\r\n\r\n") else {
        return WebUiProbeOutcome::Unavailable;
    };
    if !http_status_is_ok(headers) || !content_type_is_html(headers) || !body_is_office_web_ui(body)
    {
        return WebUiProbeOutcome::Unavailable;
    }
    WebUiProbeOutcome::Compatible
}

fn content_type_is_html(headers: &str) -> bool {
    let mut content_type = None;
    for line in headers.lines().skip(1) {
        let Some((name, value)) = line.split_once(':') else {
            continue;
        };
        if name.trim().eq_ignore_ascii_case("content-type") {
            if content_type.is_some() {
                return false;
            }
            content_type = value.split(';').next().map(str::trim);
        }
    }
    content_type.is_some_and(|media_type| media_type.eq_ignore_ascii_case("text/html"))
}

fn body_is_office_web_ui(body: &str) -> bool {
    let normalized = body.to_ascii_lowercase();
    normalized.contains("<!doctype html>")
        && normalized.contains("<title>hermes office</title>")
        && normalized.contains("id=\"app\"")
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
        if health_check(address, deadline)
            && desktop_readiness_proof_check(address, desktop_capability, deadline)
        {
            if let Some(status) = child.try_wait()? {
                return Err(format!("Office Server exited during startup ({status}).").into());
            }
            return Ok(());
        }
        thread::sleep(Duration::from_millis(100));
    }
    Err("Office Server did not become ready within 50 seconds.".into())
}

fn health_check(address: SocketAddr, startup_deadline: Instant) -> bool {
    let deadline = response_deadline(startup_deadline);
    let Some(connect_timeout) = remaining_timeout(deadline, Duration::from_millis(200)) else {
        return false;
    };
    let Ok(mut stream) = TcpStream::connect_timeout(&address, connect_timeout) else {
        return false;
    };
    if set_write_timeout_until(&stream, deadline).is_err() {
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
    let Ok(response) = read_bounded_response(
        &mut stream,
        MAX_HEALTH_RESPONSE as usize,
        deadline,
        false,
    ) else {
        return false;
    };
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

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum DesktopProofOutcome {
    Valid,
    Invalid,
    TransientUnavailable,
}

fn desktop_readiness_proof_check(
    address: SocketAddr,
    desktop_capability: &str,
    startup_deadline: Instant,
) -> bool {
    desktop_readiness_proof_outcome(address, desktop_capability, startup_deadline)
        == DesktopProofOutcome::Valid
}

fn desktop_readiness_proof_outcome(
    address: SocketAddr,
    desktop_capability: &str,
    startup_deadline: Instant,
) -> DesktopProofOutcome {
    let nonce = random_hex::<DESKTOP_PROOF_NONCE_BYTES>();
    let deadline = response_deadline(startup_deadline);
    let Some(connect_timeout) = remaining_timeout(deadline, Duration::from_millis(200)) else {
        return DesktopProofOutcome::TransientUnavailable;
    };
    let Ok(mut stream) = TcpStream::connect_timeout(&address, connect_timeout) else {
        return DesktopProofOutcome::TransientUnavailable;
    };
    if set_write_timeout_until(&stream, deadline).is_err() {
        return DesktopProofOutcome::TransientUnavailable;
    }
    let request = format!(
        "GET /api/v1/health/desktop-proof?nonce={nonce}&domain={DESKTOP_PROOF_DOMAIN}&version={DESKTOP_PROOF_VERSION} HTTP/1.1\r\nHost: {OFFICE_HOST}:{OFFICE_PORT}\r\nConnection: close\r\n\r\n"
    );
    if stream.write_all(request.as_bytes()).is_err() {
        return DesktopProofOutcome::TransientUnavailable;
    }
    let response = match read_bounded_response(
        &mut stream,
        MAX_HEALTH_RESPONSE as usize,
        deadline,
        false,
    ) {
        Ok(response) => response,
        Err(BoundedReadError::LimitExceeded) => return DesktopProofOutcome::Invalid,
        Err(BoundedReadError::Timeout | BoundedReadError::Io) => {
            return DesktopProofOutcome::TransientUnavailable;
        }
    };
    let text = match String::from_utf8(response) {
        Ok(value) => value,
        Err(_) => return DesktopProofOutcome::Invalid,
    };
    if validate_desktop_proof_response(&text, desktop_capability, &nonce) {
        DesktopProofOutcome::Valid
    } else {
        DesktopProofOutcome::Invalid
    }
}

#[derive(serde::Deserialize)]
#[serde(deny_unknown_fields)]
struct DesktopProofResponse {
    proof: String,
}

fn validate_desktop_proof_response(response: &str, capability: &str, nonce: &str) -> bool {
    let Some((headers, body)) = response.split_once("\r\n\r\n") else {
        return false;
    };
    if !http_status_is_ok(headers) || !proof_headers_are_strict(headers) {
        return false;
    }
    let parsed: DesktopProofResponse = match serde_json::from_str(body) {
        Ok(value) => value,
        Err(_) => return false,
    };
    let Some(proof) = decode_lower_hex_32(&parsed.proof) else {
        return false;
    };
    let mut mac = match Hmac::<Sha256>::new_from_slice(capability.as_bytes()) {
        Ok(value) => value,
        Err(_) => return false,
    };
    mac.update(desktop_proof_message(nonce).as_bytes());
    mac.verify_slice(&proof).is_ok()
}

fn proof_headers_are_strict(headers: &str) -> bool {
    let mut content_type = None;
    let mut cache_control = None;
    for line in headers.split("\r\n").skip(1) {
        let Some((name, value)) = line.split_once(':') else {
            return false;
        };
        if name.eq_ignore_ascii_case("content-type") {
            if content_type.replace(value.trim()).is_some() {
                return false;
            }
        }
        if name.eq_ignore_ascii_case("cache-control") {
            if cache_control.replace(value.trim()).is_some() {
                return false;
            }
        }
    }
    content_type.is_some_and(|value| value.eq_ignore_ascii_case("application/json; charset=utf-8"))
        && cache_control.is_some_and(|value| value.eq_ignore_ascii_case("no-store"))
}

fn desktop_proof_message(nonce: &str) -> String {
    format!("{DESKTOP_PROOF_DOMAIN}\n{DESKTOP_PROOF_VERSION}\n{nonce}")
}

fn decode_lower_hex_32(value: &str) -> Option<[u8; 32]> {
    if value.len() != 64 || !value.bytes().all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte)) {
        return None;
    }
    let mut decoded = [0_u8; 32];
    for (index, pair) in value.as_bytes().chunks_exact(2).enumerate() {
        decoded[index] = (hex_nibble(pair[0])? << 4) | hex_nibble(pair[1])?;
    }
    Some(decoded)
}

fn hex_nibble(value: u8) -> Option<u8> {
    match value {
        b'0'..=b'9' => Some(value - b'0'),
        b'a'..=b'f' => Some(value - b'a' + 10),
        _ => None,
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum BoundedReadError {
    Timeout,
    LimitExceeded,
    Io,
}

fn response_deadline(outer_deadline: Instant) -> Instant {
    std::cmp::min(outer_deadline, Instant::now() + HEALTH_RESPONSE_TIMEOUT)
}

fn remaining_timeout(deadline: Instant, maximum: Duration) -> Option<Duration> {
    deadline
        .checked_duration_since(Instant::now())
        .filter(|remaining| !remaining.is_zero())
        .map(|remaining| std::cmp::min(remaining, maximum))
}

fn set_write_timeout_until(stream: &TcpStream, deadline: Instant) -> std::io::Result<()> {
    let timeout = remaining_timeout(deadline, HTTP_READ_SLICE)
        .ok_or_else(|| std::io::Error::new(std::io::ErrorKind::TimedOut, "HTTP deadline elapsed"))?;
    stream.set_write_timeout(Some(timeout))
}

fn read_bounded_response(
    stream: &mut TcpStream,
    maximum: usize,
    deadline: Instant,
    stop_after_headers: bool,
) -> Result<Vec<u8>, BoundedReadError> {
    let mut response = Vec::new();
    let mut buffer = [0_u8; 512];
    loop {
        let Some(timeout) = remaining_timeout(deadline, HTTP_READ_SLICE) else {
            return Err(BoundedReadError::Timeout);
        };
        stream
            .set_read_timeout(Some(timeout))
            .map_err(|_| BoundedReadError::Io)?;
        let capped_length = maximum
            .saturating_add(1)
            .saturating_sub(response.len())
            .min(buffer.len());
        match stream.read(&mut buffer[..capped_length]) {
            Ok(0) => {
                return if Instant::now() < deadline {
                    Ok(response)
                } else {
                    Err(BoundedReadError::Timeout)
                };
            }
            Ok(size) => {
                response.extend_from_slice(&buffer[..size]);
                if response.len() > maximum {
                    return Err(BoundedReadError::LimitExceeded);
                }
                if Instant::now() >= deadline {
                    return Err(BoundedReadError::Timeout);
                }
                if stop_after_headers
                    && response.windows(4).any(|window| window == b"\r\n\r\n")
                {
                    return Ok(response);
                }
            }
            Err(error)
                if matches!(
                    error.kind(),
                    std::io::ErrorKind::WouldBlock | std::io::ErrorKind::TimedOut
                ) =>
            {
                if Instant::now() >= deadline {
                    return Err(BoundedReadError::Timeout);
                }
            }
            Err(_) => return Err(BoundedReadError::Io),
        }
    }
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
    let status = wait_for_bounded_child(&mut child, VERSION_TIMEOUT)
        .map_err(|_| "runtime version probe failed".to_owned())?
        .ok_or_else(|| "runtime version probe timed out".to_owned())?;
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

/// Wait for a short-lived helper process and reap it. A timed-out helper is
/// killed and reaped before this function returns; `None` represents timeout.
fn wait_for_bounded_child(
    child: &mut Child,
    timeout: Duration,
) -> std::io::Result<Option<ExitStatus>> {
    let deadline = Instant::now() + timeout;
    loop {
        match child.try_wait() {
            Ok(Some(status)) => return Ok(Some(status)),
            Ok(None) => {}
            Err(error) => {
                let _ = child.kill();
                let _ = child.wait();
                return Err(error);
            }
        }
        let Some(remaining) = deadline.checked_duration_since(Instant::now()) else {
            let _ = child.kill();
            let _ = child.wait();
            return Ok(None);
        };
        if remaining.is_zero() {
            let _ = child.kill();
            let _ = child.wait();
            return Ok(None);
        }
        thread::sleep(std::cmp::min(remaining, CHILD_POLL_INTERVAL));
    }
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
    fn desktop_readiness_proof_requires_exact_hmac_nonce_and_response_contract() {
        let capability = "desktop-proof-test-capability";
        let nonce = "ab".repeat(DESKTOP_PROOF_NONCE_BYTES);
        let mut mac = Hmac::<Sha256>::new_from_slice(capability.as_bytes()).expect("HMAC key");
        mac.update(desktop_proof_message(&nonce).as_bytes());
        let proof = mac.finalize().into_bytes();
        let proof_hex = encode_lower_hex(&proof);
        let response = format!(
            "HTTP/1.1 200 OK\r\nContent-Type: application/json; charset=utf-8\r\nCache-Control: no-store\r\n\r\n{{\"proof\":\"{proof_hex}\"}}"
        );

        assert!(validate_desktop_proof_response(&response, capability, &nonce));
        assert!(!validate_desktop_proof_response(&response, "wrong-capability", &nonce));
        assert!(!validate_desktop_proof_response(&response, capability, &"cd".repeat(32)));
        assert!(!validate_desktop_proof_response(
            &response.replace("Cache-Control: no-store\r\n", ""),
            capability,
            &nonce,
        ));
        assert!(!validate_desktop_proof_response(
            &response.replace("application/json; charset=utf-8", "text/plain"),
            capability,
            &nonce,
        ));
        assert!(!validate_desktop_proof_response(
            &response.replace("200 OK", "201 Created"),
            capability,
            &nonce,
        ));
        assert!(decode_lower_hex_32(&proof_hex).is_some());
        assert!(decode_lower_hex_32(&proof_hex.to_ascii_uppercase()).is_none());
        assert!(decode_lower_hex_32("00").is_none());
    }

    #[test]
    fn readiness_challenge_never_transmits_capability_and_rejects_forged_listener_proof() {
        let listener = TcpListener::bind(SocketAddr::from((Ipv4Addr::LOCALHOST, 0)))
            .expect("bind malicious temporary listener");
        let address = listener.local_addr().expect("temporary listener address");
        let capability = "capability-must-never-cross-the-readiness-socket".to_owned();
        let secret_for_assertion = capability.clone();
        let (sender, receiver) = std::sync::mpsc::channel();
        thread::spawn(move || {
            let (mut stream, _) = listener.accept().expect("accept readiness challenge");
            let mut request = [0_u8; 2048];
            let read = stream.read(&mut request).expect("read readiness challenge");
            sender.send(request[..read].to_vec()).expect("send captured request");
            let forged = "0".repeat(64);
            let body = format!("{{\"proof\":\"{forged}\"}}");
            let response = format!(
                "HTTP/1.1 200 OK\r\nContent-Type: application/json; charset=utf-8\r\nCache-Control: no-store\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
                body.len(),
            );
            stream.write_all(response.as_bytes()).expect("write forged proof");
        });

        assert_eq!(
            desktop_readiness_proof_outcome(
                address,
                &capability,
                Instant::now() + Duration::from_secs(2),
            ),
            DesktopProofOutcome::Invalid,
        );
        let captured = receiver.recv_timeout(Duration::from_secs(1)).expect("captured request");
        let request = String::from_utf8(captured).expect("ASCII request");
        assert!(!request.contains(&secret_for_assertion));
        assert!(request.starts_with("GET /api/v1/health/desktop-proof?nonce="));
        assert!(request.contains("&domain=hermes-office-desktop-readiness&version=1 HTTP/1.1\r\n"));
        let nonce = request.split("nonce=").nth(1).and_then(|value| value.split('&').next()).expect("nonce");
        assert_eq!(nonce.len(), DESKTOP_PROOF_NONCE_BYTES * 2);
        assert!(nonce.bytes().all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte)));
    }

    #[test]
    fn readiness_timeout_is_transient_but_monitor_grace_is_strictly_bounded() {
        let listener = TcpListener::bind(SocketAddr::from((Ipv4Addr::LOCALHOST, 0)))
            .expect("bind stalling readiness listener");
        let address = listener.local_addr().expect("temporary listener address");
        let server = thread::spawn(move || {
            let (mut stream, _) = listener.accept().expect("accept readiness challenge");
            let mut request = [0_u8; 2048];
            let _ = stream.read(&mut request);
            thread::sleep(Duration::from_millis(900));
        });
        assert_eq!(
            desktop_readiness_proof_outcome(
                address,
                "owned-listener-capability",
                Instant::now() + Duration::from_secs(2),
            ),
            DesktopProofOutcome::TransientUnavailable,
        );
        server.join().expect("stalling listener exits");

        let mut failures = 0;
        assert!(!monitor_outcome_requires_invalidation(
            &OwnedCapabilityOutcome::TransientUnavailable,
            &mut failures,
        ));
        assert!(!monitor_outcome_requires_invalidation(
            &OwnedCapabilityOutcome::TransientUnavailable,
            &mut failures,
        ));
        assert!(monitor_outcome_requires_invalidation(
            &OwnedCapabilityOutcome::TransientUnavailable,
            &mut failures,
        ));
        assert!(!monitor_outcome_requires_invalidation(
            &OwnedCapabilityOutcome::Valid("capability".to_owned()),
            &mut failures,
        ));
        assert_eq!(failures, 0);
        assert!(monitor_outcome_requires_invalidation(
            &OwnedCapabilityOutcome::Invalid,
            &mut failures,
        ));
    }

    #[test]
    fn fresh_readiness_proof_rejects_an_exited_or_rebound_listener() {
        let capability = "owned-listener-capability".to_owned();
        let listener = TcpListener::bind(SocketAddr::from((Ipv4Addr::LOCALHOST, 0)))
            .expect("bind owned temporary listener");
        let address = listener.local_addr().expect("temporary listener address");
        let owned_capability = capability.clone();
        let owned = thread::spawn(move || {
            serve_readiness_proof(listener, &owned_capability);
        });
        assert!(desktop_readiness_proof_check(
            address,
            &capability,
            Instant::now() + Duration::from_secs(2),
        ));
        owned.join().expect("owned listener exits");
        assert_eq!(
            desktop_readiness_proof_outcome(
                address,
                &capability,
                Instant::now() + Duration::from_millis(200),
            ),
            DesktopProofOutcome::TransientUnavailable,
        );

        let replacement = TcpListener::bind(address).expect("rebind replacement listener");
        let attacker = thread::spawn(move || {
            serve_readiness_proof(replacement, "attacker-does-not-have-capability");
        });
        assert_eq!(
            desktop_readiness_proof_outcome(
                address,
                &capability,
                Instant::now() + Duration::from_secs(2),
            ),
            DesktopProofOutcome::Invalid,
        );
        attacker.join().expect("replacement listener exits");
    }

    fn serve_readiness_proof(listener: TcpListener, capability: &str) {
        let (mut stream, _) = listener.accept().expect("accept readiness challenge");
        stream
            .set_read_timeout(Some(Duration::from_secs(1)))
            .expect("bound readiness request read");
        let mut request = Vec::new();
        while !request.windows(4).any(|window| window == b"\r\n\r\n") {
            let mut buffer = [0_u8; 512];
            let read = stream.read(&mut buffer).expect("read readiness challenge");
            assert!(read > 0 && request.len() + read <= 2048, "bounded readiness request");
            request.extend_from_slice(&buffer[..read]);
        }
        let request = String::from_utf8(request).expect("ASCII request");
        let nonce = request
            .split("nonce=")
            .nth(1)
            .and_then(|value| value.split('&').next())
            .expect("readiness nonce");
        let mut mac = Hmac::<Sha256>::new_from_slice(capability.as_bytes()).expect("HMAC key");
        mac.update(desktop_proof_message(nonce).as_bytes());
        let proof = encode_lower_hex(&mac.finalize().into_bytes());
        let body = format!("{{\"proof\":\"{proof}\"}}");
        let response = format!(
            "HTTP/1.1 200 OK\r\nContent-Type: application/json; charset=utf-8\r\nCache-Control: no-store\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
            body.len(),
        );
        stream.write_all(response.as_bytes()).expect("write readiness proof");
    }

    #[test]
    fn startup_notice_escapes_html_and_percent_encodes_the_document() {
        assert_eq!(
            html_escape("<&>\"' <script>alert(1)</script>"),
            "&lt;&amp;&gt;&quot;&#39; &lt;script&gt;alert(1)&lt;/script&gt;"
        );
        assert_eq!(percent_encode_data("<a b='c'>&"), "%3Ca%20b%3D%27c%27%3E%26");

        let url = startup_notice_data_url(StartupNoticeKind::ExistingWebUiUnavailable);
        assert!(url.starts_with("data:text/html;charset=utf-8,"));
        assert!(!url.contains('<'));
        assert!(!url.contains('>'));
        assert!(!url.contains(' '));
        assert!(!url.contains("<script"));
    }

    #[test]
    fn startup_window_uses_app_assets_only_after_owned_server_readiness() {
        let app_url = tauri::WebviewUrl::App(PathBuf::from("index.html"));
        assert_eq!(
            startup_window_url(&app_url, None).expect("app URL should be preserved"),
            app_url
        );
    }

    #[test]
    fn startup_window_uses_fixed_notice_as_its_initial_url_on_failure() {
        let app_url = tauri::WebviewUrl::External(
            tauri::Url::parse("http://127.0.0.1:4317/server-supplied")
                .expect("fixture URL should parse"),
        );
        let url = startup_window_url(
            &app_url,
            Some(StartupNoticeKind::ExistingServerCandidate),
        )
        .expect("fixed notice URL should parse");

        let tauri::WebviewUrl::CustomProtocol(url) = url else {
            panic!("notice must be the initial custom-protocol data URL");
        };
        assert_eq!(url.scheme(), "data");
        assert!(url.as_str().starts_with("data:text/html;charset=utf-8,"));
        assert!(!url.as_str().contains("server-supplied"));
    }

    #[test]
    fn startup_notices_use_cause_specific_fixed_recovery_instructions() {
        let port_used = startup_notice_html(StartupNoticeKind::PortUsedByOtherService);
        assert!(port_used.contains("which application owns loopback port 4317"));
        assert!(port_used.contains("close it normally"));
        assert!(port_used.contains("Do not force-kill"));
        assert!(!port_used.contains("build the web assets"));
        assert!(!port_used.contains("combined development surface"));

        let incompatible = startup_notice_html(StartupNoticeKind::ExistingServerIncompatible);
        assert!(incompatible.contains("verify that the process owning loopback port 4317"));
        assert!(incompatible.contains("update it to a version"));
        assert!(incompatible.contains("compatible server"));

        let malformed = startup_notice_html(StartupNoticeKind::ExistingServerMalformed);
        assert!(malformed.contains("listener and its logs"));
        assert!(malformed.contains("health response is invalid"));

        let timeout = startup_notice_html(StartupNoticeKind::ExistingServerTimeout);
        assert!(timeout.contains("health check timed out"));
        assert!(timeout.contains("Restart that service normally"));

        let web_timeout = startup_notice_html(StartupNoticeKind::ExistingWebUiTimeout);
        assert!(web_timeout.contains("Web UI response timed out"));
        assert!(web_timeout.contains("listener and its logs"));

        let web_ui = startup_notice_html(StartupNoticeKind::ExistingWebUiUnavailable);
        assert!(web_ui.contains("normal combined development surface"));
        assert!(web_ui.contains("build the web assets"));
        assert!(web_ui.contains(OFFICE_URL));

        let candidate = startup_notice_html(StartupNoticeKind::ExistingServerCandidate);
        assert!(candidate.contains("do not verify its identity"));
        assert!(candidate.contains("confirm that the process which owns loopback port 4317"));
        assert!(candidate.contains(OFFICE_URL));
        assert!(candidate.contains("manually open"));
        assert!(candidate.contains("do not open the URL"));
        assert!(candidate.contains("will not kill it automatically"));
        assert!(!candidate.contains("automatically open"));
        assert!(!candidate.contains("default browser"));

        let runtime = startup_notice_html(StartupNoticeKind::OwnedManagedRuntimeUnavailable);
        assert!(runtime.contains("managed Node.js and Hermes Agent runtimes"));
        assert!(runtime.contains("Repair or reinstall the managed runtime"));

        let resource = startup_notice_html(StartupNoticeKind::OwnedBundledResourceUnavailable);
        assert!(resource.contains("Reinstall Hermes Office from a complete application bundle"));
        assert!(resource.contains("server resources are restored"));

        let launch = startup_notice_html(StartupNoticeKind::OwnedChildLaunchFailed);
        assert!(launch.contains("allowed to launch processes"));
        assert!(launch.contains("reinstall the application and its managed runtime"));

        let readiness = startup_notice_html(StartupNoticeKind::OwnedServerReadinessFailed);
        assert!(readiness.contains("Close Hermes Office normally"));
        assert!(readiness.contains("which application owns loopback port 4317"));
        assert!(readiness.contains("Repair or reinstall the managed runtime"));
        assert!(!readiness.contains("server logs"));

        let state = startup_notice_html(StartupNoticeKind::InternalStateUnavailable);
        assert!(state.contains("Close Hermes Office normally"));
        assert!(state.contains("do not manually stop unrelated processes"));

        for notice in [
            StartupNoticeKind::ExistingServerCandidate,
            StartupNoticeKind::ExistingServerIncompatible,
            StartupNoticeKind::ExistingServerMalformed,
            StartupNoticeKind::ExistingServerTimeout,
            StartupNoticeKind::PortUsedByOtherService,
            StartupNoticeKind::ExistingWebUiTimeout,
            StartupNoticeKind::OwnedManagedRuntimeUnavailable,
            StartupNoticeKind::OwnedBundledResourceUnavailable,
            StartupNoticeKind::OwnedChildLaunchFailed,
            StartupNoticeKind::OwnedServerReadinessFailed,
            StartupNoticeKind::InternalStateUnavailable,
        ] {
            let html = startup_notice_html(notice);
            assert!(!html.contains("build the web assets"));
            assert!(!html.contains("combined development surface"));
        }
    }

    #[test]
    fn owned_launch_failures_map_to_safe_specific_notices() {
        assert_eq!(
            StartupNoticeKind::from(OwnedServerLaunchError::ManagedRuntimeUnavailable),
            StartupNoticeKind::OwnedManagedRuntimeUnavailable
        );
        assert_eq!(
            StartupNoticeKind::from(OwnedServerLaunchError::BundledResourceUnavailable),
            StartupNoticeKind::OwnedBundledResourceUnavailable
        );
        assert_eq!(
            StartupNoticeKind::from(OwnedServerLaunchError::ChildLaunchFailed),
            StartupNoticeKind::OwnedChildLaunchFailed
        );
    }

    #[test]
    fn every_startup_notice_is_self_contained_and_has_no_active_resource() {
        let notices = [
            StartupNoticeKind::ExistingServerCandidate,
            StartupNoticeKind::ExistingServerIncompatible,
            StartupNoticeKind::ExistingServerMalformed,
            StartupNoticeKind::ExistingServerTimeout,
            StartupNoticeKind::PortUsedByOtherService,
            StartupNoticeKind::ExistingWebUiUnavailable,
            StartupNoticeKind::ExistingWebUiTimeout,
            StartupNoticeKind::OwnedManagedRuntimeUnavailable,
            StartupNoticeKind::OwnedBundledResourceUnavailable,
            StartupNoticeKind::OwnedChildLaunchFailed,
            StartupNoticeKind::OwnedServerReadinessFailed,
            StartupNoticeKind::InternalStateUnavailable,
        ];
        for notice in notices {
            let html = startup_notice_html(notice);
            assert!(html.contains("No external server or process was stopped or replaced"));
            assert!(html.contains("<ol><li>"));
            assert!(!html.contains("<script"));
            assert!(!html.contains("src="));
            assert!(!html.contains("href="));
        }
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
    fn web_ui_contract_matches_the_bundled_index_and_requires_html_content_type() {
        assert!(body_is_office_web_ui(include_str!("../../../web/index.html")));
        assert!(content_type_is_html(
            "HTTP/1.1 200 OK\r\ncOnTeNt-TyPe: Text/HTML; charset=utf-8"
        ));
        assert!(!content_type_is_html(
            "HTTP/1.1 200 OK\r\nX-Content-Type-Options: text/html"
        ));
        assert!(!content_type_is_html(
            "HTTP/1.1 200 OK\r\nContent-Type: application/xhtml+xml"
        ));
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
    fn classify_compatible_existing_server_as_unauthenticated_candidate() {
        let address = bind_office_server(
            "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\n\r\n{\"ok\":true,\"protocolVersion\":1,\"runtime\":\"ready\"}",
            "HTTP/1.1 200 OK\r\ncontent-type: Text/HTML; charset=utf-8\r\n\r\n<!doctype html><html><head><title>Hermes Office</title></head><body><div id=\"app\"></div></body></html>",
        );
        assert_eq!(
            classify_office_startup(address).expect("compatible candidate should classify"),
            OfficeStartup::CompatibleCandidate
        );
    }

    #[test]
    fn classify_compatible_health_without_root_web_ui_rejects() {
        let address = bind_office_server(
            "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\n\r\n{\"ok\":true,\"protocolVersion\":1,\"runtime\":\"ready\"}",
            "HTTP/1.1 404 Not Found\r\nContent-Type: text/plain\r\n\r\nnot found",
        );
        let error = classify_office_startup(address)
            .expect_err("a health-only server must not be treated as attachable");
        assert!(error.to_string().contains("not the expected Hermes Office Web UI shape"));
    }

    #[test]
    fn classify_compatible_health_with_non_html_root_rejects() {
        let address = bind_office_server(
            "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\n\r\n{\"ok\":true,\"protocolVersion\":1,\"runtime\":\"ready\"}",
            "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\n\r\n{\"title\":\"Hermes Office\",\"id\":\"app\"}",
        );
        let error = classify_office_startup(address)
            .expect_err("a non-HTML root must not be treated as attachable");
        assert!(error.to_string().contains("not the expected Hermes Office Web UI shape"));
    }

    #[test]
    fn classify_compatible_health_with_unrelated_html_rejects() {
        let address = bind_office_server(
            "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\n\r\n{\"ok\":true,\"protocolVersion\":1,\"runtime\":\"ready\"}",
            "HTTP/1.1 200 OK\r\nContent-Type: text/html\r\n\r\n<!doctype html><html><head><title>Other App</title></head><body><div id=\"app\"></div></body></html>",
        );
        let error = classify_office_startup(address)
            .expect_err("unrelated HTML must not be treated as Hermes Office");
        assert!(error.to_string().contains("not the expected Hermes Office Web UI shape"));
    }

    #[test]
    fn classify_compatible_health_with_malformed_root_rejects() {
        let address = bind_office_server(
            "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\n\r\n{\"ok\":true,\"protocolVersion\":1,\"runtime\":\"ready\"}",
            "HTTP/1.1 200 OK\r\nContent-Type: text/html\r\n<!doctype html><title>Hermes Office</title><div id=\"app\"></div>",
        );
        let error = classify_office_startup(address)
            .expect_err("a malformed root response must not be attachable");
        assert!(error.to_string().contains("not the expected Hermes Office Web UI shape"));
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
        assert!(error.to_string().contains("not recognized as Hermes Office"));
    }

    fn bind_health_server(response: &'static str) -> SocketAddr {
        bind_http_server(vec![response])
    }

    fn bind_office_server(health_response: &'static str, root_response: &'static str) -> SocketAddr {
        bind_http_server(vec![health_response, root_response])
    }

    fn bind_http_server(responses: Vec<&'static str>) -> SocketAddr {
        let listener = TcpListener::bind(SocketAddr::from((Ipv4Addr::LOCALHOST, 0)))
            .expect("bind temporary health server");
        let address = listener.local_addr().expect("local address");
        thread::spawn(move || {
            for response in responses {
                serve_one_response(&listener, response.as_bytes());
            }
        });
        address
    }

    fn serve_one_response(listener: &TcpListener, response: &[u8]) {
        let (mut stream, _) = listener.accept().expect("accept HTTP connection");
        let mut request = [0_u8; 512];
        let _ = stream.read(&mut request);
        let _ = stream.write_all(response);
        let _ = stream.shutdown(std::net::Shutdown::Both);
    }

    #[test]
    fn classify_compatible_health_with_oversized_root_rejects() {
        let listener = TcpListener::bind(SocketAddr::from((Ipv4Addr::LOCALHOST, 0)))
            .expect("bind temporary Office server");
        let address = listener.local_addr().expect("local address");
        thread::spawn(move || {
            let health = "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\n\r\n{\"ok\":true,\"protocolVersion\":1,\"runtime\":\"ready\"}";
            serve_one_response(&listener, health.as_bytes());
            let oversized = vec![b'x'; MAX_WEB_UI_RESPONSE + 1];
            serve_one_response(&listener, &oversized);
        });
        let error = classify_office_startup(address)
            .expect_err("an oversized root response must not be attachable");
        assert!(error.to_string().contains("not the expected Hermes Office Web UI shape"));
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
            // long enough for the absolute health-response deadline to fire.
            let mut buffer = [0_u8; 512];
            let _ = stream.read(&mut buffer);
            thread::sleep(Duration::from_millis(800));
        });
        let error = classify_office_startup(address).expect_err("stalling server should error");
        assert_eq!(error, StartupProbeError::Timeout);
    }

    #[test]
    fn classify_slow_drip_health_response_obeys_absolute_deadline() {
        let listener = TcpListener::bind(SocketAddr::from((Ipv4Addr::LOCALHOST, 0)))
            .expect("bind temporary health server");
        let address = listener.local_addr().expect("local address");
        thread::spawn(move || {
            let (mut stream, _) = listener.accept().expect("accept health connection");
            let mut request = [0_u8; 512];
            let _ = stream.read(&mut request);
            for byte in b"HTTP/1.1 200 OK\r\nContent-Type: application/json\r\n\r\n{\"ok\":true,\"protocolVersion\":1,\"runtime\":\"ready\"}" {
                if stream.write_all(std::slice::from_ref(byte)).is_err() {
                    break;
                }
                thread::sleep(Duration::from_millis(100));
            }
        });

        let started = Instant::now();
        let error = classify_office_startup(address)
            .expect_err("a slow-drip response must not extend the probe indefinitely");
        let elapsed = started.elapsed();

        assert_eq!(error, StartupProbeError::Timeout);
        assert!(
            elapsed < Duration::from_secs(2),
            "absolute health deadline was exceeded: {elapsed:?}"
        );
    }

    #[test]
    fn classify_stalling_root_response_is_web_ui_timeout() {
        let listener = TcpListener::bind(SocketAddr::from((Ipv4Addr::LOCALHOST, 0)))
            .expect("bind temporary Office server");
        let address = listener.local_addr().expect("local address");
        thread::spawn(move || {
            let health = "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\n\r\n{\"ok\":true,\"protocolVersion\":1,\"runtime\":\"ready\"}";
            serve_one_response(&listener, health.as_bytes());
            let (mut stream, _) = listener.accept().expect("accept root connection");
            let mut request = [0_u8; 512];
            let _ = stream.read(&mut request);
            thread::sleep(Duration::from_millis(800));
        });

        let started = Instant::now();
        let error = classify_office_startup(address)
            .expect_err("a stalling Web UI must not extend the probe indefinitely");
        let elapsed = started.elapsed();

        assert!(error.to_string().contains("Web UI probe timed out"));
        assert!(
            elapsed < Duration::from_secs(2),
            "absolute Web UI deadline was exceeded: {elapsed:?}"
        );
    }
}
