use super::*;
use std::{
    fs,
    path::Path,
    sync::atomic::{AtomicU64, Ordering},
    time::{SystemTime, UNIX_EPOCH},
};

const SECRET_CANARY: &str = "synthetic-launch-secret-canary";
static NEXT_ROOT: AtomicU64 = AtomicU64::new(1);

struct TestRoot(PathBuf);

impl TestRoot {
    fn new() -> Self {
        let sequence = NEXT_ROOT.fetch_add(1, Ordering::Relaxed);
        let nanos = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        Self(std::env::temp_dir().join(format!(
            "matcha-agent-launch-{}-{nanos}-{sequence}",
            std::process::id()
        )))
    }
}

impl Drop for TestRoot {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}

fn absolute_path(name: &str) -> PathBuf {
    if cfg!(windows) {
        PathBuf::from(format!(r"C:\MatchaClaw\{name}"))
    } else {
        PathBuf::from(format!("/MatchaClaw/{name}"))
    }
}

fn input(root: &TestRoot) -> LaunchInput {
    LaunchInput {
        bun_executable: absolute_path("bin/bun"),
        entry: absolute_path("matcha-agent/dist/cli-bun.js"),
        working_directory: absolute_path("runtime"),
        storage_root: root.0.clone(),
        port: 18_790,
        secret: Arc::new(Secret::new(SECRET_CANARY.to_owned()).unwrap()),
        #[cfg(windows)]
        git_bash: absolute_path("bin/bash.exe"),
    }
}

#[tokio::test]
async fn materializes_exact_app_server_specification_without_files() {
    let root = TestRoot::new();
    let mut launch = input(&root).try_into_launch_factory().unwrap();

    assert!(root.0.is_dir());
    assert_exact_spec(&launch.spec, &root.0);

    let first = launch.materialize().await.unwrap();
    let second = launch.materialize().await.unwrap();
    drop(first);
    drop(second);

    assert!(root.0.is_dir());
    assert!(!root.0.join("private").exists());
}

#[test]
fn provisions_missing_storage_ancestors_without_private_material() {
    let root = TestRoot::new();
    fs::create_dir(&root.0).unwrap();
    let storage_root = root.0.join("missing-parent").join("storage");
    let mut input = input(&root);
    input.storage_root = storage_root.clone();

    let launch = input.try_into_launch_factory().unwrap();

    assert!(storage_root.is_dir());
    assert!(!storage_root.join("private").exists());
    drop(launch);
}

#[test]
fn rejects_a_storage_leaf_that_is_an_existing_file() {
    let root = TestRoot::new();
    fs::write(&root.0, b"non-secret-storage-leaf").unwrap();

    let error = match input(&root).try_into_launch_factory() {
        Ok(_) => panic!("storage leaf file was accepted"),
        Err(error) => error,
    };

    assert_eq!(error, LaunchError::StorageRootProvision);
    assert!(root.0.is_file());
    assert!(!root.0.join("private").exists());
}

#[cfg(unix)]
#[test]
fn preserves_existing_storage_root_permissions_without_private_material() {
    use std::os::unix::fs::PermissionsExt;

    let root = TestRoot::new();
    fs::create_dir(&root.0).unwrap();
    fs::set_permissions(&root.0, fs::Permissions::from_mode(0o755)).unwrap();

    let launch = input(&root).try_into_launch_factory().unwrap();

    assert_eq!(
        fs::metadata(&root.0).unwrap().permissions().mode() & 0o777,
        0o755
    );
    assert!(!root.0.join("private").exists());
    drop(launch);
}

#[test]
fn rejects_static_input_before_provisioning_storage() {
    let root = TestRoot::new();
    let mut input = input(&root);
    input.bun_executable = PathBuf::from("relative-sensitive-artifact");

    let error = match input.try_into_launch_factory() {
        Ok(_) => panic!("invalid matcha-agent launch input was accepted"),
        Err(error) => error,
    };

    assert_eq!(error, LaunchError::InvalidInput);
    assert_eq!(error.to_string(), "matcha-agent launch input is invalid");
    assert!(!format!("{error:?} {error}").contains("sensitive"));
    assert!(!root.0.exists());
}

#[test]
fn rejects_an_auth_token_that_cannot_be_exposed_as_an_argument() {
    let root = TestRoot::new();
    let mut input = input(&root);
    input.secret = Arc::new(Secret::new(format!("{SECRET_CANARY}\0")).unwrap());

    let error = match input.try_into_launch_factory() {
        Ok(_) => panic!("invalid launch specification was accepted"),
        Err(error) => error,
    };

    assert_eq!(
        error,
        LaunchError::InvalidSpec(InvalidLaunchSpec::ArgumentContainsNul)
    );
    assert_eq!(
        error.to_string(),
        "matcha-agent launch specification is invalid: argument contains NUL"
    );
    assert!(!format!("{error:?} {error}").contains(SECRET_CANARY));
    assert!(!root.0.exists());
}

#[cfg(windows)]
#[test]
fn rejects_an_invalid_git_bash_path_without_exposing_the_auth_token() {
    let root = TestRoot::new();
    let mut input = input(&root);
    input.git_bash = PathBuf::from("C:\\MatchaClaw\\invalid\0bash.exe");

    let error = match input.try_into_launch_factory() {
        Ok(_) => panic!("invalid launch specification was accepted"),
        Err(error) => error,
    };

    assert_eq!(
        error,
        LaunchError::InvalidSpec(InvalidLaunchSpec::EnvironmentValueContainsNul)
    );
    assert_eq!(
        error.to_string(),
        "matcha-agent launch specification is invalid: public environment value contains NUL"
    );
    assert!(!format!("{error:?} {error}").contains(SECRET_CANARY));
    assert!(!root.0.exists());
}

#[cfg(unix)]
#[test]
fn rejects_a_symlinked_storage_root_before_creating_private_material() {
    use std::os::unix::fs::symlink;

    let root = TestRoot::new();
    fs::create_dir(&root.0).unwrap();
    let target = root.0.join("target");
    fs::create_dir(&target).unwrap();
    let storage_root = root.0.join("storage");
    symlink(&target, &storage_root).unwrap();
    let mut input = input(&root);
    input.storage_root = storage_root;

    let error = match input.try_into_launch_factory() {
        Ok(_) => panic!("reparse storage root was accepted"),
        Err(error) => error,
    };

    assert_eq!(error, LaunchError::StorageRootProvision);
    assert!(!target.join("private").exists());
}

#[cfg(unix)]
#[test]
fn rejects_a_symlinked_storage_ancestor_before_creating_private_material() {
    use std::os::unix::fs::symlink;

    let root = TestRoot::new();
    fs::create_dir(&root.0).unwrap();
    let target = root.0.join("target");
    fs::create_dir(&target).unwrap();
    let ancestor = root.0.join("ancestor");
    symlink(&target, &ancestor).unwrap();
    let mut input = input(&root);
    input.storage_root = ancestor.join("storage");

    let error = match input.try_into_launch_factory() {
        Ok(_) => panic!("reparse storage ancestor was accepted"),
        Err(error) => error,
    };

    assert_eq!(error, LaunchError::StorageRootProvision);
    assert!(!target.join("storage").exists());
}

#[cfg(windows)]
#[test]
fn rejects_a_reparse_storage_root_before_creating_private_material() {
    use std::process::Command;

    let root = TestRoot::new();
    fs::create_dir(&root.0).unwrap();
    let target = root.0.join("target");
    fs::create_dir(&target).unwrap();
    let storage_root = root.0.join("storage");
    assert!(
        Command::new("cmd")
            .args(["/C", "mklink", "/J"])
            .arg(&storage_root)
            .arg(&target)
            .output()
            .unwrap()
            .status
            .success()
    );
    let mut input = input(&root);
    input.storage_root = storage_root;

    let error = match input.try_into_launch_factory() {
        Ok(_) => panic!("reparse storage root was accepted"),
        Err(error) => error,
    };

    assert_eq!(error, LaunchError::StorageRootProvision);
    assert!(!target.join("private").exists());
}

#[cfg(windows)]
#[test]
fn rejects_a_reparse_storage_ancestor_before_creating_private_material() {
    use std::process::Command;

    let root = TestRoot::new();
    fs::create_dir(&root.0).unwrap();
    let target = root.0.join("target");
    fs::create_dir(&target).unwrap();
    let ancestor = root.0.join("ancestor");
    assert!(
        Command::new("cmd")
            .args(["/C", "mklink", "/J"])
            .arg(&ancestor)
            .arg(&target)
            .output()
            .unwrap()
            .status
            .success()
    );
    let mut input = input(&root);
    input.storage_root = ancestor.join("storage");

    let error = match input.try_into_launch_factory() {
        Ok(_) => panic!("reparse storage ancestor was accepted"),
        Err(error) => error,
    };

    assert_eq!(error, LaunchError::StorageRootProvision);
    assert!(!target.join("storage").exists());
}

fn assert_exact_spec(spec: &LaunchSpec, storage_root: &Path) {
    assert_eq!(spec.executable(), Path::new(&absolute_path("bin/bun")));
    assert_eq!(
        spec.working_directory(),
        Path::new(&absolute_path("runtime"))
    );
    assert_eq!(
        spec.arguments(),
        [
            absolute_path("matcha-agent/dist/cli-bun.js").into_os_string(),
            "app-server".into(),
            "--host".into(),
            APP_SERVER_HOST.into(),
            "--port".into(),
            "18790".into(),
            "--storage-root".into(),
            storage_root.as_os_str().to_owned(),
            "--auth-token".into(),
            SECRET_CANARY.into(),
        ]
    );
    assert_eq!(
        spec.public_environment(),
        [
            (FORCE_COLOR.into(), "0".into()),
            (NO_COLOR.into(), "1".into()),
            #[cfg(windows)]
            (SYSTEM_ROOT.into(), windows_system_root().unwrap()),
            #[cfg(windows)]
            (
                CLAUDE_CODE_GIT_BASH_PATH.into(),
                absolute_path("bin/bash.exe").into_os_string(),
            ),
        ]
    );
    assert_eq!(spec.stdio(), APP_SERVER_STDIO);
    assert!(
        !spec
            .arguments()
            .iter()
            .any(|argument| argument == SECRET_CANARY)
    );

    for unsupported_option in [
        "--auth-token-file",
        "--tls-cert-file",
        "--tls-key-file",
        "--cron-broker-endpoint",
        "--cron-broker-private-key-path",
    ] {
        assert!(
            !spec
                .arguments()
                .iter()
                .any(|argument| argument == unsupported_option)
        );
    }
}
