#[cfg(windows)]
use std::{
    fs,
    path::{Path, PathBuf},
    sync::atomic::{AtomicU64, Ordering},
};

#[cfg(windows)]
use super::provision_private_directory;

#[cfg(windows)]
#[test]
fn fleet_private_root_existing_directory_is_hardened() {
    let root = TempRoot::new();
    let private_root = root.path().join("fleet-private");
    fs::create_dir(&private_root).unwrap();

    provision_private_directory(&private_root).unwrap();
    foundation::storage::set_private_mode(
        &private_root,
        foundation::storage::PrivateMode::Directory,
    )
    .unwrap();
}

#[cfg(windows)]
#[test]
fn fleet_private_root_rejects_file() {
    let root = TempRoot::new();
    let private_root = root.path().join("fleet-private");
    fs::write(&private_root, b"not a directory").unwrap();

    assert!(provision_private_directory(&private_root).is_err());
}

#[cfg(windows)]
struct TempRoot(PathBuf);

#[cfg(windows)]
impl TempRoot {
    fn new() -> Self {
        static NEXT_ID: AtomicU64 = AtomicU64::new(0);
        let id = NEXT_ID.fetch_add(1, Ordering::Relaxed);
        let path = std::env::temp_dir().join(format!(
            "matcha-host-provisioning-private-{}-{id}",
            std::process::id()
        ));
        fs::create_dir(&path).unwrap();
        Self(path)
    }

    fn path(&self) -> &Path {
        &self.0
    }
}

#[cfg(windows)]
impl Drop for TempRoot {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}
