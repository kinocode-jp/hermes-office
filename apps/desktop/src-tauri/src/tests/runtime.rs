use std::{
    env,
    ffi::OsString,
    process::Command,
};

use crate::hex_util::random_desktop_capability;
use crate::runtime::{
    hermes_candidates, hermes_version_is_compatible, inherit_office_remote_environment,
    node_candidates, node_version_is_compatible, validated_local_executable,
};

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
        "hermes-studio-runtime-validation-{}-{}",
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
fn office_remote_environment_allowlist_is_exact_when_host_values_present() {
    let mut lookup = std::collections::HashMap::new();
    lookup.insert("HERMES_STUDIO_REMOTE_TOKEN", OsString::from("office-token"));
    lookup.insert("HERMES_STUDIO_ALLOWED_ORIGINS", OsString::from("https://office.example"));
    lookup.insert("HERMES_STUDIO_TRUSTED_PROXY_HOPS", OsString::from("1"));
    let mut command = Command::new("/bin/sh");
    command.env_clear();
    inherit_office_remote_environment(&mut command, |key| lookup.get(key).cloned());
    let envs: Vec<(String, String)> = command
        .get_envs()
        .filter_map(|(k, v)| {
            v.map(|v| (k.to_string_lossy().into_owned(), v.to_string_lossy().into_owned()))
        })
        .collect();
    assert!(envs.contains(&("HERMES_STUDIO_REMOTE_TOKEN".to_string(), "office-token".to_string())));
    assert!(envs.contains(&("HERMES_STUDIO_ALLOWED_ORIGINS".to_string(), "https://office.example".to_string())));
    assert!(envs.contains(&("HERMES_STUDIO_TRUSTED_PROXY_HOPS".to_string(), "1".to_string())));
    assert_eq!(envs.len(), 3, "only the three allowed Office keys may be forwarded");
}

#[test]
fn office_remote_environment_allowlist_ignores_empty_or_missing_values() {
    let mut lookup = std::collections::HashMap::new();
    lookup.insert("HERMES_STUDIO_REMOTE_TOKEN", OsString::from(""));
    lookup.insert("HERMES_OFFICE_REMOTE_TOKEN", OsString::from("deprecated-value"));
    let mut command = Command::new("/bin/sh");
    command.env_clear();
    inherit_office_remote_environment(&mut command, |key| lookup.get(key).cloned());
    let envs: Vec<(String, String)> = command
        .get_envs()
        .filter_map(|(k, v)| {
            v.map(|v| (k.to_string_lossy().into_owned(), v.to_string_lossy().into_owned()))
        })
        .collect();
    assert!(
        envs.is_empty(),
        "an explicitly empty Studio value must disable legacy fallback",
    );
}
