use std::{
    env,
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

struct OfficeServerProcess(Mutex<Option<Child>>);

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let app = tauri::Builder::default()
        .manage(OfficeServerProcess(Mutex::new(None)))
        .setup(|app| {
            // `tauri dev` already starts Office Server through beforeDevCommand.
            // The bundled release owns exactly one sidecar process itself.
            if !cfg!(debug_assertions) {
                ensure_office_port_available()?;
                let mut child = start_office_server(app)?;
                if let Err(error) = wait_for_office_server(&mut child, START_TIMEOUT) {
                    stop_office_server(&mut child);
                    return Err(error);
                }
                *app.state::<OfficeServerProcess>()
                    .0
                    .lock()
                    .expect("server process lock") = Some(child);
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

fn start_office_server(app: &tauri::App) -> Result<Child, Box<dyn std::error::Error>> {
    let resource_dir = app.path().resource_dir()?;
    let script = resource_dir.join("resources/server/hermes-office-server.mjs");
    if !script.is_file() {
        return Err(format!("Office Server resource is missing: {}", script.display()).into());
    }

    let home = env::var_os("HOME").map(PathBuf::from);
    let node = find_executable("HERMES_OFFICE_NODE", &node_candidates(home.as_deref()))
        .ok_or("Node.js was not found in Hermes or a known absolute install path.")?;
    let hermes = find_executable(
        "HERMES_OFFICE_HERMES_EXECUTABLE",
        &hermes_candidates(home.as_deref()),
    )
    .ok_or("Hermes Agent was not found in a known absolute install path.")?;

    let mut command = Command::new(node);
    command
        .arg(script)
        .env("HERMES_OFFICE_HOST", OFFICE_HOST)
        .env("HERMES_OFFICE_PORT", OFFICE_PORT.to_string())
        .env("HERMES_OFFICE_HERMES_MODE", "managed")
        .env("HERMES_OFFICE_HERMES_EXECUTABLE", hermes)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    if let Some(directory) = home {
        command.current_dir(directory);
    }
    Ok(command.spawn()?)
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

fn find_executable(override_name: &str, candidates: &[PathBuf]) -> Option<PathBuf> {
    if let Some(value) = env::var_os(override_name).filter(|value| !value.is_empty()) {
        let path = PathBuf::from(value);
        if path.is_absolute() && is_executable_file(&path) {
            return Some(path);
        }
    }
    candidates
        .iter()
        .find(|path| path.is_absolute() && is_executable_file(path))
        .cloned()
}

fn is_executable_file(path: &Path) -> bool {
    let Ok(metadata) = path.metadata() else {
        return false;
    };
    if !metadata.is_file() {
        return false;
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        metadata.permissions().mode() & 0o111 != 0
    }
    #[cfg(not(unix))]
    {
        true
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
}
