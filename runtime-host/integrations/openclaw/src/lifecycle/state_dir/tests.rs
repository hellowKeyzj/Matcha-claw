use std::{fs, path::PathBuf};

use super::{AgentId, CanonicalStateDir, PrivateAuthProfiles, StateDirError};

struct TempParent(PathBuf);

impl TempParent {
    fn new() -> Self {
        let mut attempt = 0_u32;
        let parent = loop {
            let parent = std::env::temp_dir().join(format!(
                "openclaw-state-dir-parent-{}-{}-{attempt}",
                std::process::id(),
                unique_id()
            ));
            match fs::create_dir(&parent) {
                Ok(()) => break parent,
                Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {
                    attempt += 1;
                }
                Err(error) => panic!("create test parent: {error}"),
            }
        };
        set_private_access(&parent);
        Self(parent)
    }

    fn child(&self, name: &str) -> PathBuf {
        self.0.join(name)
    }
}

impl Drop for TempParent {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}

fn unique_id() -> u128 {
    use std::time::{SystemTime, UNIX_EPOCH};

    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .expect("clock must follow Unix epoch")
        .as_nanos()
}

#[test]
fn rejects_relative_paths_with_a_fixed_redacted_error() {
    let error = CanonicalStateDir::provision("state-secret-canary").unwrap_err();

    assert_eq!(error, StateDirError);
    assert_eq!(error.to_string(), "OpenClaw state directory rejected");
    assert_eq!(format!("{error:?}"), "StateDirError");
    assert!(!error.to_string().contains("state-secret-canary"));
}

#[test]
fn provisions_only_the_missing_leaf_and_stores_a_canonical_path() {
    let parent = TempParent::new();
    let requested = parent.child("state");

    let state_dir = CanonicalStateDir::provision(&requested).unwrap();

    assert!(state_dir.as_path().is_absolute());
    assert_eq!(
        fs::canonicalize(state_dir.as_path()).unwrap(),
        fs::canonicalize(requested).unwrap()
    );
    assert!(state_dir.open().is_ok());
    assert_eq!(format!("{state_dir:?}"), "CanonicalStateDir([REDACTED])");
}

#[cfg(windows)]
#[test]
fn accepts_an_existing_protected_owner_only_directory() {
    let parent = TempParent::new();
    let requested = parent.child("state");
    fs::create_dir(&requested).unwrap();
    set_private_access(&requested);

    CanonicalStateDir::provision(&requested).unwrap();
}

#[cfg(windows)]
#[test]
fn existing_current_user_directory_is_hardened_before_acceptance() {
    let parent = TempParent::new();
    let requested = parent.child("state");
    fs::create_dir(&requested).unwrap();
    let before = security_descriptor(&requested);

    CanonicalStateDir::provision(&requested).unwrap();

    assert_ne!(security_descriptor(&requested), before);
}

#[test]
fn rejects_a_missing_parent() {
    let parent = TempParent::new();
    let requested = parent.child("missing").join("state");

    assert_eq!(
        CanonicalStateDir::provision(requested).unwrap_err(),
        StateDirError
    );
}

#[test]
fn attempt_open_rejects_a_replaced_leaf() {
    let parent = TempParent::new();
    let requested = parent.child("state");
    let state_dir = CanonicalStateDir::provision(&requested).unwrap();
    fs::remove_dir(&requested).unwrap();
    let replacement = parent.child("replacement");
    fs::create_dir(&replacement).unwrap();
    set_private_access(&replacement);
    fs::rename(&replacement, &requested).unwrap();

    assert_eq!(state_dir.open().unwrap_err(), StateDirError);
}

#[cfg(windows)]
#[test]
fn opened_state_directory_blocks_rename_until_handle_release() {
    let parent = TempParent::new();
    let requested = parent.child("state");
    let state_dir = CanonicalStateDir::provision(&requested).unwrap();
    let lease = state_dir.open().unwrap();
    let moved = parent.child("moved");

    assert!(fs::rename(&requested, &moved).is_err());
    drop(lease);
    fs::rename(&requested, &moved).unwrap();
}

#[test]
fn auth_profiles_are_custodied_at_the_fixed_private_agent_path() {
    let parent = TempParent::new();
    let requested = parent.child("state");
    let state_dir = CanonicalStateDir::provision(&requested).unwrap();
    let agent = AgentId::try_new("primary-agent".into()).unwrap();
    let initial =
        PrivateAuthProfiles::try_new(b"{\"token\":\"auth-secret-canary\"}".to_vec()).unwrap();
    let replacement =
        PrivateAuthProfiles::try_new(b"{\"token\":\"replacement-secret-canary\"}".to_vec())
            .unwrap();

    assert!(state_dir.read_auth_profiles(&agent).unwrap().is_none());
    state_dir.replace_auth_profiles(&agent, &initial).unwrap();
    state_dir
        .replace_auth_profiles(&agent, &replacement)
        .unwrap();
    let path = state_dir
        .as_path()
        .join("agents")
        .join("primary-agent")
        .join("agent")
        .join("auth-profiles.json");
    assert_eq!(fs::read(&path).unwrap(), replacement.as_bytes());
    assert_eq!(
        state_dir
            .read_auth_profiles(&agent)
            .unwrap()
            .unwrap()
            .as_bytes(),
        replacement.as_bytes()
    );
    assert!(format!("{replacement:?}").contains("[REDACTED]"));
    assert!(!format!("{replacement:?}").contains("replacement-secret-canary"));
    assert!(!format!("{agent:?}").contains("primary-agent"));
}

#[test]
fn auth_profiles_reject_noncanonical_agent_id_without_exposure() {
    for agent in ["", "Agent", "../agent", "agent/name", "agent name"] {
        let error = AgentId::try_new(agent.into()).unwrap_err();
        let rendered = format!("{error:?} {error}");

        assert_eq!(error, StateDirError);
        if !agent.is_empty() {
            assert!(!rendered.contains(agent));
        }
    }
}

#[cfg(unix)]
#[test]
fn auth_profiles_reject_an_existing_non_private_file_without_exposure() {
    use std::os::unix::fs::PermissionsExt;

    let parent = TempParent::new();
    let requested = parent.child("state");
    let state_dir = CanonicalStateDir::provision(&requested).unwrap();
    let agent = AgentId::try_new("primary-agent".into()).unwrap();
    let path = state_dir
        .as_path()
        .join("agents")
        .join("primary-agent")
        .join("agent")
        .join("auth-profiles.json");
    fs::create_dir_all(path.parent().unwrap()).unwrap();
    fs::write(&path, b"auth-secret-canary").unwrap();
    fs::set_permissions(&path, fs::Permissions::from_mode(0o644)).unwrap();

    let error = state_dir.read_auth_profiles(&agent).unwrap_err();
    let rendered = format!("{error:?} {error}");

    assert_eq!(error, StateDirError);
    assert!(!rendered.contains("auth-secret-canary"));
    assert!(!rendered.contains(path.to_string_lossy().as_ref()));
}

#[cfg(unix)]
#[test]
fn auth_profiles_are_owner_only_after_atomic_replacement() {
    use std::os::unix::fs::PermissionsExt;

    let parent = TempParent::new();
    let requested = parent.child("state");
    let state_dir = CanonicalStateDir::provision(&requested).unwrap();
    let agent = AgentId::try_new("primary-agent".into()).unwrap();
    let first = PrivateAuthProfiles::try_new(b"{\"token\":\"first\"}".to_vec()).unwrap();
    let second = PrivateAuthProfiles::try_new(b"{\"token\":\"second\"}".to_vec()).unwrap();

    state_dir.replace_auth_profiles(&agent, &first).unwrap();
    state_dir.replace_auth_profiles(&agent, &second).unwrap();

    let path = state_dir
        .as_path()
        .join("agents")
        .join("primary-agent")
        .join("agent")
        .join("auth-profiles.json");
    assert_eq!(fs::read(&path).unwrap(), second.as_bytes());
    assert_eq!(
        fs::metadata(path).unwrap().permissions().mode() & 0o777,
        0o600
    );
}

#[test]
fn read_regular_file_bounded_reads_only_a_regular_leaf() {
    let parent = TempParent::new();
    let requested = parent.child("state");
    let state_dir = CanonicalStateDir::provision(&requested).unwrap();
    fs::write(requested.join("regular"), b"state contents").unwrap();

    assert_eq!(
        state_dir
            .open()
            .unwrap()
            .read_regular_file_bounded("regular", 16),
        Ok(Some(b"state contents".to_vec()))
    );
    assert_eq!(
        state_dir
            .open()
            .unwrap()
            .read_regular_file_bounded("missing", 16),
        Ok(None)
    );
}

#[test]
fn read_regular_file_bounded_rejects_an_oversized_file() {
    let parent = TempParent::new();
    let requested = parent.child("state");
    let state_dir = CanonicalStateDir::provision(&requested).unwrap();
    fs::write(requested.join("oversized"), b"too large").unwrap();

    assert_eq!(
        state_dir
            .open()
            .unwrap()
            .read_regular_file_bounded("oversized", 3)
            .unwrap_err(),
        StateDirError
    );
}

#[test]
fn replace_regular_file_bounded_replaces_existing_file_and_cleans_temporary_files() {
    let parent = TempParent::new();
    let requested = parent.child("state");
    let state_dir = CanonicalStateDir::provision(&requested).unwrap();
    let target = requested.join("settings");
    fs::write(&target, b"old settings").unwrap();

    state_dir
        .replace_regular_file_bounded("settings", b"new settings", 64)
        .unwrap();

    assert_eq!(fs::read(&target).unwrap(), b"new settings");
    assert_eq!(
        state_dir.read_regular_file_bounded("settings", 64).unwrap(),
        Some(b"new settings".to_vec())
    );
    assert_eq!(fs::read_dir(&requested).unwrap().count(), 1);
}

#[test]
fn replace_regular_file_bounded_rejects_oversized_contents_without_touching_target() {
    let parent = TempParent::new();
    let requested = parent.child("state");
    let state_dir = CanonicalStateDir::provision(&requested).unwrap();
    let target = requested.join("settings");
    fs::write(&target, b"old settings").unwrap();

    assert_eq!(
        state_dir
            .replace_regular_file_bounded("settings", b"too large", 3)
            .unwrap_err(),
        StateDirError
    );
    assert_eq!(fs::read(&target).unwrap(), b"old settings");
    assert_eq!(fs::read_dir(&requested).unwrap().count(), 1);
}

#[test]
fn read_regular_file_bounded_rejects_invalid_relative_names() {
    let parent = TempParent::new();
    let requested = parent.child("state");
    let state_dir = CanonicalStateDir::provision(&requested).unwrap();
    let state_dir = state_dir.open().unwrap();

    for name in ["", ".", "..", "nested/file", "/absolute"] {
        assert_eq!(
            state_dir.read_regular_file_bounded(name, 1).unwrap_err(),
            StateDirError,
            "expected {name:?} to be rejected"
        );
    }
}

#[cfg(windows)]
#[test]
fn read_regular_file_bounded_rejects_backslash_separated_names() {
    let parent = TempParent::new();
    let requested = parent.child("state");
    let state_dir = CanonicalStateDir::provision(&requested).unwrap();

    assert_eq!(
        state_dir
            .open()
            .unwrap()
            .read_regular_file_bounded(r"nested\file", 1)
            .unwrap_err(),
        StateDirError
    );
}

#[cfg(unix)]
#[test]
fn read_regular_file_bounded_rejects_a_symlink() {
    let parent = TempParent::new();
    let requested = parent.child("state");
    let state_dir = CanonicalStateDir::provision(&requested).unwrap();
    let target = parent.child("target");
    fs::write(&target, b"target").unwrap();
    std::os::unix::fs::symlink(&target, requested.join("linked")).unwrap();

    assert_eq!(
        state_dir
            .open()
            .unwrap()
            .read_regular_file_bounded("linked", 16)
            .unwrap_err(),
        StateDirError
    );
}

#[cfg(windows)]
#[test]
fn read_regular_file_bounded_rejects_a_reparse_point() {
    let parent = TempParent::new();
    let requested = parent.child("state");
    let state_dir = CanonicalStateDir::provision(&requested).unwrap();
    let target = parent.child("target");
    fs::write(&target, b"target").unwrap();
    let link = requested.join("linked");
    if std::os::windows::fs::symlink_file(&target, &link).is_err() {
        return;
    }

    assert_eq!(
        state_dir
            .open()
            .unwrap()
            .read_regular_file_bounded("linked", 16)
            .unwrap_err(),
        StateDirError
    );
}

#[cfg(unix)]
#[test]
fn read_regular_file_bounded_rejects_a_non_regular_file() {
    let parent = TempParent::new();
    let requested = parent.child("state");
    let state_dir = CanonicalStateDir::provision(&requested).unwrap();
    fs::create_dir(requested.join("directory")).unwrap();

    assert_eq!(
        state_dir
            .open()
            .unwrap()
            .read_regular_file_bounded("directory", 16)
            .unwrap_err(),
        StateDirError
    );
}

#[cfg(unix)]
#[test]
fn read_regular_file_bounded_rejects_a_fifo() {
    use std::{ffi::CString, os::unix::ffi::OsStrExt};

    let parent = TempParent::new();
    let requested = parent.child("state");
    let state_dir = CanonicalStateDir::provision(&requested).unwrap();
    let fifo = CString::new(requested.join("fifo").as_os_str().as_bytes()).unwrap();

    assert_eq!(unsafe { libc::mkfifo(fifo.as_ptr(), 0o600) }, 0);
    assert_eq!(
        state_dir
            .open()
            .unwrap()
            .read_regular_file_bounded("fifo", 16)
            .unwrap_err(),
        StateDirError
    );
}

#[cfg(unix)]
#[test]
fn existing_directory_is_rejected_without_changing_its_mode() {
    use std::os::unix::fs::PermissionsExt;

    let parent = TempParent::new();
    let requested = parent.child("state");
    fs::create_dir(&requested).unwrap();
    fs::set_permissions(&requested, fs::Permissions::from_mode(0o755)).unwrap();

    assert_eq!(
        CanonicalStateDir::provision(&requested).unwrap_err(),
        StateDirError
    );
    assert_eq!(
        fs::metadata(&requested).unwrap().permissions().mode() & 0o777,
        0o755
    );
}

#[cfg(unix)]
#[test]
fn rejects_a_symlink_in_an_ancestor_component() {
    let parent = TempParent::new();
    let target = parent.child("target");
    fs::create_dir(&target).unwrap();
    set_private_access(&target);
    let link = parent.child("link");
    std::os::unix::fs::symlink(&target, &link).unwrap();

    assert_eq!(
        CanonicalStateDir::provision(link.join("state")).unwrap_err(),
        StateDirError
    );
}

#[cfg(windows)]
#[test]
fn rejects_a_reparse_point_in_an_ancestor_component() {
    let parent = TempParent::new();
    let target = parent.child("target");
    fs::create_dir(&target).unwrap();
    set_private_access(&target);
    let link = parent.child("link");
    if std::os::windows::fs::symlink_dir(&target, &link).is_err() {
        return;
    }

    assert_eq!(
        CanonicalStateDir::provision(link.join("state")).unwrap_err(),
        StateDirError
    );
}

#[cfg(unix)]
fn set_private_access(path: &std::path::Path) {
    use std::os::unix::fs::PermissionsExt;

    fs::set_permissions(path, fs::Permissions::from_mode(0o700)).unwrap();
}

#[cfg(windows)]
fn security_descriptor(path: &std::path::Path) -> String {
    use std::{os::windows::ffi::OsStrExt, ptr::null_mut};
    use windows_sys::Win32::{Foundation as F, Security as S, Security::Authorization as A};

    let name: Vec<u16> = path.as_os_str().encode_wide().chain([0]).collect();
    let mut descriptor = null_mut();
    assert_eq!(
        unsafe {
            A::GetNamedSecurityInfoW(
                name.as_ptr(),
                A::SE_FILE_OBJECT,
                S::OWNER_SECURITY_INFORMATION | S::DACL_SECURITY_INFORMATION,
                null_mut(),
                null_mut(),
                null_mut(),
                null_mut(),
                &mut descriptor,
            )
        },
        F::ERROR_SUCCESS
    );
    let mut encoded = null_mut();
    assert_ne!(
        unsafe {
            A::ConvertSecurityDescriptorToStringSecurityDescriptorW(
                descriptor,
                A::SDDL_REVISION_1,
                S::OWNER_SECURITY_INFORMATION | S::DACL_SECURITY_INFORMATION,
                &mut encoded,
                null_mut(),
            )
        },
        0
    );
    let length = unsafe { (0..).take_while(|index| *encoded.add(*index) != 0).count() };
    let value = String::from_utf16(unsafe { std::slice::from_raw_parts(encoded, length) }).unwrap();
    unsafe {
        F::LocalFree(encoded.cast());
        F::LocalFree(descriptor);
    }
    value
}

#[cfg(windows)]
fn set_private_access(path: &std::path::Path) {
    use std::{
        os::windows::{
            ffi::OsStrExt,
            io::{AsRawHandle, FromRawHandle, OwnedHandle, RawHandle},
        },
        ptr::{null, null_mut},
    };
    use windows_sys::Win32::{
        Foundation as F, Security as S, Security::Authorization as A, Storage::FileSystem as FS,
    };

    let name: Vec<u16> = path.as_os_str().encode_wide().chain([0]).collect();
    let raw = unsafe {
        FS::CreateFileW(
            name.as_ptr(),
            FS::WRITE_DAC | FS::READ_CONTROL,
            FS::FILE_SHARE_READ | FS::FILE_SHARE_WRITE | FS::FILE_SHARE_DELETE,
            null(),
            FS::OPEN_EXISTING,
            FS::FILE_FLAG_BACKUP_SEMANTICS | FS::FILE_FLAG_OPEN_REPARSE_POINT,
            null_mut(),
        )
    };
    assert_ne!(raw, F::INVALID_HANDLE_VALUE);
    let handle = unsafe { OwnedHandle::from_raw_handle(raw as RawHandle) };
    let sddl: Vec<u16> = "D:P(A;OICI;FA;;;OW)".encode_utf16().chain([0]).collect();
    let mut descriptor = null_mut();
    assert_ne!(
        unsafe {
            A::ConvertStringSecurityDescriptorToSecurityDescriptorW(
                sddl.as_ptr(),
                A::SDDL_REVISION_1,
                &mut descriptor,
                null_mut(),
            )
        },
        0
    );
    let mut present = 0;
    let mut defaulted = 0;
    let mut dacl = null_mut();
    assert_ne!(
        unsafe {
            S::GetSecurityDescriptorDacl(descriptor, &mut present, &mut dacl, &mut defaulted)
        },
        0
    );
    assert_eq!(
        unsafe {
            A::SetSecurityInfo(
                handle.as_raw_handle() as F::HANDLE,
                A::SE_FILE_OBJECT,
                S::PROTECTED_DACL_SECURITY_INFORMATION | S::DACL_SECURITY_INFORMATION,
                null_mut(),
                null_mut(),
                dacl,
                null_mut(),
            )
        },
        F::ERROR_SUCCESS
    );
    unsafe { F::LocalFree(descriptor) };
}
