mod capability;
mod constants;
mod diagnostics;
mod health;
mod hex_util;
mod http;
mod proof;
mod runtime;
mod secret_transfer;
mod server;
mod startup;
mod web_ui;
mod window;

#[cfg(test)]
mod tests;

use std::sync::Mutex;

use tauri::{Manager, RunEvent};

use capability::{
    desktop_capability, desktop_owned, start_owned_server_monitor, DesktopCapability,
    DesktopProofGate, OfficeServerProcess,
};
use secret_transfer::deposit_secret_transfer;
use server::{setup_office, stop_office_server};
use startup::OfficeLaunch;
use window::{build_main_window, StartupView};

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let app = tauri::Builder::default()
        .manage(OfficeServerProcess(Mutex::new(None)))
        .manage(DesktopCapability(Mutex::new(None)))
        .manage(DesktopProofGate(Mutex::new(())))
        .invoke_handler(tauri::generate_handler![
            desktop_capability,
            desktop_owned,
            deposit_secret_transfer
        ])
        .setup(|app| {
            // `main` has `create: false` in tauri.conf.json. Do not create a
            // WebView until the loopback listener has been classified.
            // - Free port: start an owned child, prove readiness, open bundled UI.
            // - Compatible existing server (health + Web UI shape): open
            //   http://127.0.0.1:4317/ in the WebView (same UI as a browser).
            //   Do not own, stop, or kill that process.
            // - Other failures: fixed self-contained notice page.
            //
            // Never return Err from this hook: with release `panic = "abort"`,
            // Tauri turns setup errors into SIGABRT (macOS crash report) instead
            // of a recoverable in-app notice. Window-creation failures are logged.
            let (view, owned_ready) = match setup_office(app) {
                Ok(OfficeLaunch::OwnedReady) => (StartupView::BundledApp, true),
                Ok(OfficeLaunch::ExistingOpen) => (StartupView::ExistingOffice, false),
                Err(failure) => (StartupView::Notice(failure), false),
            };
            match build_main_window(app, view) {
                Ok(()) => {
                    if owned_ready {
                        start_owned_server_monitor(app.handle().clone());
                    }
                }
                Err(error) => {
                    // Window creation can happen after an owned child is ready.
                    // If the native window cannot be created, do not orphan that
                    // child while the application continues without a window.
                    if let Ok(mut process) = app.state::<OfficeServerProcess>().0.lock() {
                        if let Some(mut child) = process.take() {
                            stop_office_server(&mut child);
                        }
                    }
                    eprintln!(
                        "Hermes Studio could not create its window (continuing without abort): {error}"
                    );
                }
            }
            Ok(())
        })
        .build(tauri::generate_context!());

    let app = match app {
        Ok(app) => app,
        Err(error) => {
            eprintln!("Hermes Studio could not start safely: {error}");
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
