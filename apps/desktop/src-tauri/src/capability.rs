use std::{
    net::{Ipv4Addr, SocketAddr},
    process::Child,
    sync::{Mutex, MutexGuard, TryLockError},
    thread,
    time::{Duration, Instant},
};

use tauri::Manager;

use crate::constants::{
    CHILD_POLL_INTERVAL, HEALTH_RESPONSE_TIMEOUT, OFFICE_PORT, OWNED_SERVER_MONITOR_INTERVAL,
    OWNED_SERVER_TRANSIENT_FAILURE_LIMIT,
};
use crate::http::remaining_timeout;
use crate::proof::{desktop_readiness_proof_outcome, DesktopProofOutcome};

pub(crate) struct OfficeServerProcess(pub(crate) Mutex<Option<Child>>);
pub(crate) struct DesktopCapability(pub(crate) Mutex<Option<String>>);
pub(crate) struct DesktopProofGate(pub(crate) Mutex<()>);

#[tauri::command]
pub(crate) async fn desktop_capability(app: tauri::AppHandle) -> Option<String> {
    let worker_app = app.clone();
    let outcome = tauri::async_runtime::spawn_blocking(move || {
        authenticated_owned_capability(&worker_app)
    })
    .await
    .unwrap_or(OwnedCapabilityOutcome::TransientUnavailable);
    match outcome {
        OwnedCapabilityOutcome::Valid(capability) => Some(capability),
        OwnedCapabilityOutcome::Invalid => {
            close_owned_desktop_window(&app);
            None
        }
        // Attached existing Office: no capability, no window close.
        OwnedCapabilityOutcome::NotOwned | OwnedCapabilityOutcome::TransientUnavailable => None,
    }
}

#[tauri::command]
pub(crate) async fn desktop_owned(app: tauri::AppHandle) -> bool {
    let worker_app = app.clone();
    let outcome = tauri::async_runtime::spawn_blocking(move || {
        authenticated_owned_capability(&worker_app)
    })
    .await
    .unwrap_or(OwnedCapabilityOutcome::TransientUnavailable);
    match outcome {
        OwnedCapabilityOutcome::Valid(_) => true,
        OwnedCapabilityOutcome::Invalid => {
            close_owned_desktop_window(&app);
            false
        }
        // Never owned (opened an existing loopback Office) — browser-like session.
        OwnedCapabilityOutcome::NotOwned | OwnedCapabilityOutcome::TransientUnavailable => false,
    }
}

pub(crate) enum OwnedCapabilityOutcome {
    Valid(String),
    /// This shell never started an owned child (e.g. attached existing Office).
    NotOwned,
    Invalid,
    TransientUnavailable,
}

pub(crate) enum BoundedLockError {
    TimedOut,
    Poisoned,
}

pub(crate) fn lock_until<T>(
    mutex: &Mutex<T>,
    deadline: Instant,
) -> Result<MutexGuard<'_, T>, BoundedLockError> {
    loop {
        match mutex.try_lock() {
            Ok(guard) => return Ok(guard),
            Err(TryLockError::Poisoned(_)) => return Err(BoundedLockError::Poisoned),
            Err(TryLockError::WouldBlock) => {
                let Some(delay) = remaining_timeout(deadline, CHILD_POLL_INTERVAL) else {
                    return Err(BoundedLockError::TimedOut);
                };
                thread::sleep(delay);
            }
        }
    }
}

pub(crate) fn authenticated_owned_capability(app: &tauri::AppHandle) -> OwnedCapabilityOutcome {
    let deadline = Instant::now() + HEALTH_RESPONSE_TIMEOUT;
    let proof_gate_state = app.state::<DesktopProofGate>();
    let _proof_gate = match lock_until(&proof_gate_state.0, deadline) {
        Ok(proof_gate) => proof_gate,
        Err(BoundedLockError::TimedOut) => return OwnedCapabilityOutcome::TransientUnavailable,
        Err(BoundedLockError::Poisoned) => return invalid_owned_capability(app),
    };
    let capability_state = app.state::<DesktopCapability>();
    let capability = match lock_until(&capability_state.0, deadline) {
        Ok(capability) => capability.clone(),
        Err(BoundedLockError::TimedOut) => return OwnedCapabilityOutcome::TransientUnavailable,
        Err(BoundedLockError::Poisoned) => return invalid_owned_capability(app),
    };
    let Some(capability) = capability else {
        // ExistingOpen / browser-equivalent WebView: no owned child and no
        // desktop capability. Do not treat this as Invalid (which closes the
        // window) — the web client falls through to local cookie auth.
        return OwnedCapabilityOutcome::NotOwned;
    };
    match owned_child_outcome(app, deadline) {
        OwnedChildOutcome::Running => {}
        OwnedChildOutcome::Exited | OwnedChildOutcome::InvalidState => {
            return invalid_owned_capability(app);
        }
        OwnedChildOutcome::TransientUnavailable => {
            return OwnedCapabilityOutcome::TransientUnavailable;
        }
    }
    let address = SocketAddr::from((Ipv4Addr::LOCALHOST, OFFICE_PORT));
    match desktop_readiness_proof_outcome(
        address,
        &capability,
        deadline,
    ) {
        DesktopProofOutcome::Valid => {}
        DesktopProofOutcome::Invalid => {
            return invalid_owned_capability(app);
        }
        DesktopProofOutcome::TransientUnavailable => {
            return OwnedCapabilityOutcome::TransientUnavailable;
        }
    }
    match owned_child_outcome(app, deadline) {
        OwnedChildOutcome::Running => {}
        OwnedChildOutcome::Exited | OwnedChildOutcome::InvalidState => {
            return invalid_owned_capability(app);
        }
        OwnedChildOutcome::TransientUnavailable => {
            return OwnedCapabilityOutcome::TransientUnavailable;
        }
    }
    let current = match lock_until(&capability_state.0, deadline) {
        Ok(current) => current,
        Err(BoundedLockError::TimedOut) => return OwnedCapabilityOutcome::TransientUnavailable,
        Err(BoundedLockError::Poisoned) => return invalid_owned_capability(app),
    };
    if current.as_deref() == Some(capability.as_str()) {
        OwnedCapabilityOutcome::Valid(capability)
    } else {
        drop(current);
        invalid_owned_capability(app)
    }
}

fn invalid_owned_capability(app: &tauri::AppHandle) -> OwnedCapabilityOutcome {
    clear_desktop_capability(app);
    OwnedCapabilityOutcome::Invalid
}

pub(crate) fn clear_desktop_capability(app: &tauri::AppHandle) {
    let capability_state = app.state::<DesktopCapability>();
    clear_optional_state(&capability_state.0);
}

pub(crate) fn clear_optional_state<T>(state: &Mutex<Option<T>>) {
    let mut value = state
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner);
    *value = None;
}

enum OwnedChildOutcome {
    Running,
    Exited,
    TransientUnavailable,
    InvalidState,
}

fn owned_child_outcome(app: &tauri::AppHandle, deadline: Instant) -> OwnedChildOutcome {
    let process_state = app.state::<OfficeServerProcess>();
    let mut process = match lock_until(&process_state.0, deadline) {
        Ok(process) => process,
        Err(BoundedLockError::TimedOut) => return OwnedChildOutcome::TransientUnavailable,
        Err(BoundedLockError::Poisoned) => return OwnedChildOutcome::InvalidState,
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

pub(crate) fn close_owned_desktop_window(app: &tauri::AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.close();
    }
}

pub(crate) fn monitor_outcome_requires_invalidation(
    outcome: &OwnedCapabilityOutcome,
    consecutive_transient_failures: &mut u8,
) -> bool {
    match outcome {
        OwnedCapabilityOutcome::Valid(_) => {
            *consecutive_transient_failures = 0;
            false
        }
        OwnedCapabilityOutcome::NotOwned => false,
        OwnedCapabilityOutcome::Invalid => true,
        OwnedCapabilityOutcome::TransientUnavailable => {
            *consecutive_transient_failures =
                (*consecutive_transient_failures).saturating_add(1);
            *consecutive_transient_failures >= OWNED_SERVER_TRANSIENT_FAILURE_LIMIT
        }
    }
}

pub(crate) fn start_owned_server_monitor(app: tauri::AppHandle) {
    thread::spawn(move || {
        let mut consecutive_transient_failures = 0_u8;
        loop {
            thread::sleep(OWNED_SERVER_MONITOR_INTERVAL);
            let outcome = authenticated_owned_capability(&app);
            if monitor_outcome_requires_invalidation(
                &outcome,
                &mut consecutive_transient_failures,
            ) {
                clear_desktop_capability(&app);
                close_owned_desktop_window(&app);
                return;
            }
        }
    });
}
