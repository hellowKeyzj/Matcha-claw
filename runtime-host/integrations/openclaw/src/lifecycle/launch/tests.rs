use std::{
    ffi::{OsStr, OsString},
    fs,
    path::Path,
    sync::Arc,
    sync::atomic::{AtomicU64, Ordering},
    time::{SystemTime, UNIX_EPOCH},
};

use super::*;

const SECRET_CANARY: &str = "synthetic-openclaw-launch-secret-canary";
static NEXT_ROOT: AtomicU64 = AtomicU64::new(1);

struct TestRoot {
    cleanup_root: PathBuf,
    state_dir: CanonicalStateDir,
    working_directory: PathBuf,
}

impl TestRoot {
    fn new() -> Self {
        let sequence = NEXT_ROOT.fetch_add(1, Ordering::Relaxed);
        let nanos = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let cleanup_root = std::env::temp_dir().join(format!(
            "openclaw-launch-{}-{nanos}-{sequence}",
            std::process::id()
        ));
        fs::create_dir(&cleanup_root).unwrap();
        let state_dir = CanonicalStateDir::provision(cleanup_root.join("openclaw")).unwrap();
        let working_directory = cleanup_root.join("working");
        fs::create_dir(&working_directory).unwrap();
        Self {
            cleanup_root,
            state_dir,
            working_directory,
        }
    }

    fn path(&self) -> &Path {
        self.state_dir.as_path()
    }
}

impl Drop for TestRoot {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.cleanup_root);
    }
}

fn absolute_path(name: &str) -> PathBuf {
    if cfg!(windows) {
        PathBuf::from(format!(r"C:\MatchaClaw\{name}"))
    } else {
        PathBuf::from(format!("/MatchaClaw/{name}"))
    }
}

fn input(root: &TestRoot) -> OpenClawLaunchInput {
    OpenClawLaunchInput {
        electron_image: absolute_path("MatchaClaw"),
        working_directory: root.working_directory.clone(),
        openclaw_dir: absolute_path("openclaw"),
        entry: absolute_path("openclaw/openclaw.mjs"),
        state_dir: root.state_dir.clone(),
        port: 18_789,
        secret: Arc::new(GatewaySecret::new(SECRET_CANARY.into()).unwrap()),
    }
}

fn write_settings(root: &TestRoot, proxy: &str) {
    fs::write(
        root.path().join(SETTINGS_DESIRED_FILE),
        format!(
            r#"{{"revision":1,"browserMode":"relay","proxy":{proxy},"launchAtStartup":false,"gatewayAutoStart":true,"effect":"confirmed","correlations":[]}}"#
        ),
    )
    .unwrap();
}

#[tokio::test]
async fn launch_attempt_uses_only_the_legacy_gateway_contract() {
    let root = TestRoot::new();
    fs::write(
        root.path().join(CANONICAL_CONFIG_FILE),
        br#"{"channels":{}}"#,
    )
    .unwrap();
    let mut launch = input(&root).try_into_launch_factory().unwrap();

    let prepared = launch.prepare_attempt().unwrap();
    assert_exact_spec(prepared.spec(), &root, true);
    let attempt = prepared.materialize().unwrap();
    drop(attempt);

    assert_eq!(fs::read_dir(root.path()).unwrap().count(), 1);
    assert_eq!(
        fs::read(root.path().join(CANONICAL_CONFIG_FILE)).unwrap(),
        br#"{"channels":{}}"#
    );
}

#[test]
fn configured_channels_omit_skip_from_the_exact_public_environment() {
    let root = TestRoot::new();
    fs::write(
        root.path().join(CANONICAL_CONFIG_FILE),
        br#"{"channels":{"feishu":{"appId":"app-id"}}}"#,
    )
    .unwrap();
    let mut launch = input(&root).try_into_launch_factory().unwrap();

    let prepared = launch.prepare_attempt().unwrap();

    assert_exact_spec(prepared.spec(), &root, false);
}

#[cfg(unix)]
#[tokio::test]
async fn materializing_a_missing_canonical_config_preserves_it_after_attempt_cleanup() {
    let root = TestRoot::new();
    let canonical = root.path().join(CANONICAL_CONFIG_FILE);
    let mut launch = input(&root).try_into_launch_factory().unwrap();

    let attempt = launch.materialize().await.unwrap();

    assert_eq!(fs::read(&canonical).unwrap(), b"{}\n");
    drop(attempt);
    assert_eq!(fs::read(canonical).unwrap(), b"{}\n");
}

#[cfg(windows)]
#[test]
fn missing_canonical_config_is_initialized_with_state_dir_and_without_overlay_environment() {
    let root = TestRoot::new();
    let mut launch = input(&root).try_into_launch_factory().unwrap();
    let canonical = root.path().join(CANONICAL_CONFIG_FILE);

    let prepared = launch.prepare_attempt().unwrap();

    assert_eq!(fs::read(&canonical).unwrap(), b"{}\n");
    assert!(
        prepared
            .spec()
            .public_environment()
            .contains(&(OPENCLAW_STATE_DIR.into(), root.path().into()))
    );
    assert!(
        !prepared
            .spec()
            .public_environment()
            .iter()
            .any(|(key, value)| key == "OPENCLAW_CONFIG_PATH" || value == canonical.as_os_str())
    );
}

#[test]
fn canonical_initialization_preserves_existing_configuration_bytes() {
    let root = TestRoot::new();
    let canonical = root.path().join(CANONICAL_CONFIG_FILE);
    let contents = br#"{"channels":{"feishu":{"appId":"app-id"}}}"#;
    fs::write(&canonical, contents).unwrap();

    input(&root).try_into_launch_factory().unwrap();

    assert_eq!(fs::read(canonical).unwrap(), contents);
}

#[test]
fn each_attempt_rereads_the_canonical_channel_configuration() {
    let root = TestRoot::new();
    let canonical = root.path().join(CANONICAL_CONFIG_FILE);
    fs::write(&canonical, br#"{"channels":{}}"#).unwrap();
    let mut launch = input(&root).try_into_launch_factory().unwrap();

    let first = launch.prepare_attempt().unwrap();
    assert!(
        first
            .spec()
            .public_environment()
            .contains(&(OPENCLAW_SKIP_CHANNELS.into(), "1".into()))
    );
    fs::write(&canonical, br#"{"channels":{"feishu":{"appId":"app-id"}}}"#).unwrap();
    let second = launch.prepare_attempt().unwrap();

    assert!(
        !second
            .spec()
            .public_environment()
            .iter()
            .any(|(key, _)| key == OPENCLAW_SKIP_CHANNELS)
    );
}

#[test]
fn malformed_canonical_config_fails_closed_without_materializing_an_attempt() {
    for contents in [b"not-json".as_slice(), br#"[]"#] {
        let root = TestRoot::new();
        fs::write(root.path().join(CANONICAL_CONFIG_FILE), contents).unwrap();
        let mut launch = input(&root).try_into_launch_factory().unwrap();

        let failure = match launch.prepare_attempt() {
            Ok(_) => panic!("malformed canonical config must fail closed"),
            Err(failure) => failure,
        };

        assert_eq!(failure, LaunchFailure::ResourceUnavailable);
        let rendered = format!("{failure:?}");
        assert!(!rendered.contains(std::str::from_utf8(contents).unwrap()));
        assert!(!rendered.contains(root.path().to_string_lossy().as_ref()));
        assert_eq!(fs::read_dir(root.path()).unwrap().count(), 1);
    }
}

#[test]
fn prepared_attempt_rejects_a_replaced_state_directory_without_materializing() {
    let root = TestRoot::new();
    let canonical = root.path().join(CANONICAL_CONFIG_FILE);
    fs::write(&canonical, br#"{"channels":{}}"#).unwrap();
    let original_state_dir = root.path().to_path_buf();
    let mut launch = input(&root).try_into_launch_factory().unwrap();
    let prepared = launch.prepare_attempt().unwrap();

    fs::remove_file(canonical).unwrap();
    fs::remove_dir(&original_state_dir).unwrap();
    let replacement = CanonicalStateDir::provision(root.cleanup_root.join("replacement")).unwrap();
    fs::rename(replacement.as_path(), &original_state_dir).unwrap();

    let error = match prepared.materialize() {
        Ok(_) => panic!("replaced state directory was materialized"),
        Err(error) => error,
    };

    assert_eq!(error.failure(), LaunchFailure::ResourceUnavailable);
    assert_eq!(fs::read_dir(&original_state_dir).unwrap().count(), 0);
    let rendered = format!("{error:?} {error}");
    assert!(!rendered.contains(original_state_dir.to_string_lossy().as_ref()));
    assert!(!rendered.contains(SECRET_CANARY));
}

#[test]
fn rejects_static_input_before_creating_material() {
    for mutate in [
        |input: &mut OpenClawLaunchInput| input.electron_image = "secret-electron".into(),
        |input: &mut OpenClawLaunchInput| input.openclaw_dir = "secret-openclaw".into(),
        |input: &mut OpenClawLaunchInput| input.entry = "secret-entry".into(),
    ] {
        let root = TestRoot::new();
        let mut input = input(&root);
        mutate(&mut input);

        let error = match input.try_into_launch_factory() {
            Ok(_) => panic!("invalid OpenClaw launch input was accepted"),
            Err(error) => error,
        };

        assert_eq!(error, LaunchError::InvalidInput);
        assert_eq!(error.to_string(), "OpenClaw launch input is invalid");
        assert!(!format!("{error:?} {error}").contains("secret"));
        assert!(root.path().is_dir());
        assert_eq!(fs::read_dir(root.path()).unwrap().count(), 0);
    }
}

#[test]
fn zero_port_fails_closed_without_creating_material() {
    let root = TestRoot::new();
    let mut input = input(&root);
    input.port = 0;

    assert!(matches!(
        input.try_into_launch_factory(),
        Err(LaunchError::InvalidInput)
    ));
    assert!(root.path().is_dir());
    assert_eq!(fs::read_dir(root.path()).unwrap().count(), 0);
}

#[test]
fn launch_environment_strips_legacy_systemd_and_non_legacy_material() {
    let environment = sanitize_inherited_environment([
        ("OPENCLAW_SYSTEMD_UNIT".into(), "openclaw.service".into()),
        ("INVOCATION_ID".into(), "invocation".into()),
        ("SYSTEMD_EXEC_PID".into(), "123".into()),
        ("JOURNAL_STREAM".into(), "stream".into()),
        ("NODE_OPTIONS".into(), "--require secret-preload".into()),
        ("OPENCLAW_CONFIG_PATH".into(), "non-legacy-config".into()),
        ("OPENCLAW_STATE_DIR".into(), "non-legacy-state".into()),
        ("OPENCLAW_CONFIG_DIR".into(), "non-legacy-config-dir".into()),
        ("MATCHACLAW_OPENCLAW_TLS_CERT_FD".into(), "11".into()),
        ("SAFE_ENV".into(), "kept".into()),
    ]);

    assert_eq!(
        environment,
        vec![(OsString::from("SAFE_ENV"), OsString::from("kept"))]
    );
}

#[test]
fn disabled_proxy_blanks_proxy_environment() {
    let root = TestRoot::new();
    write_settings(
        &root,
        r#"{"enabled":false,"server":"http://proxy.test:8080","bypassRules":"localhost;127.0.0.1"}"#,
    );

    assert_eq!(
        proxy_environment(&root.state_dir).unwrap(),
        blank_proxy_environment()
    );
}

#[test]
fn enabled_proxy_matches_legacy_gateway_environment() {
    let root = TestRoot::new();
    write_settings(
        &root,
        r#"{"enabled":true,"server":"proxy.test:8080","bypassRules":"localhost; 127.0.0.1\n::1"}"#,
    );

    let expected = proxy_environment_keys()
        .into_iter()
        .map(|key| {
            let value = if key.eq_ignore_ascii_case(NO_PROXY) {
                "localhost,127.0.0.1,::1"
            } else {
                "http://proxy.test:8080"
            };
            (key.into(), value.into())
        })
        .collect::<Vec<(OsString, OsString)>>();
    assert_eq!(proxy_environment(&root.state_dir).unwrap(), expected);
}

fn assert_exact_spec(spec: &LaunchSpec, root: &TestRoot, skip_channels: bool) {
    assert_eq!(spec.executable(), Path::new(&absolute_path("MatchaClaw")));
    assert_eq!(
        spec.working_directory(),
        Path::new(&absolute_path("openclaw"))
    );
    assert_eq!(
        spec.arguments(),
        [
            absolute_path("openclaw/openclaw.mjs").into_os_string(),
            "gateway".into(),
            "--port".into(),
            "18789".into(),
            "--token".into(),
            SECRET_CANARY.into(),
            "--allow-unconfigured".into(),
        ]
    );
    let mut expected_environment =
        base_launch_environment(&root.working_directory, &root.state_dir).unwrap();
    expected_environment.extend([
        (OPENCLAW_GATEWAY_PORT.into(), "18789".into()),
        (OPENCLAW_GATEWAY_TOKEN.into(), SECRET_CANARY.into()),
        (OPENCLAW_STATE_DIR.into(), root.path().into()),
        (OPENCLAW_CONFIG_DIR.into(), root.path().into()),
        (MATCHACLAW_RUNTIME_HOST_GATEWAY_PORT.into(), "18789".into()),
        (
            MATCHACLAW_RUNTIME_HOST_GATEWAY_TOKEN.into(),
            SECRET_CANARY.into(),
        ),
        (OPENCLAW_NO_RESPAWN.into(), "1".into()),
        (OPENCLAW_DISABLE_BONJOUR.into(), "1".into()),
    ]);
    if skip_channels {
        expected_environment.push((OPENCLAW_SKIP_CHANNELS.into(), "1".into()));
        expected_environment.push((CLAWDBOT_SKIP_CHANNELS.into(), "1".into()));
    }
    assert_eq!(spec.public_environment(), expected_environment);
    assert_eq!(spec.stdio(), OPENCLAW_STDIO);

    let mut required_environment = vec![
        (UV_PYTHON_INSTALL_MIRROR, UV_PYTHON_INSTALL_MIRROR_URL),
        (UV_INDEX_URL, UV_INDEX_MIRROR_URL),
    ];
    required_environment.extend(proxy_environment_keys().into_iter().map(|key| (key, "")));
    for required in required_environment {
        assert!(
            spec.public_environment()
                .contains(&(required.0.into(), required.1.into())),
            "missing required launch env {required:?}"
        );
    }

    for forbidden in NON_LEGACY_LAUNCH_ENV_KEYS
        .into_iter()
        .filter(|forbidden| *forbidden != OPENCLAW_STATE_DIR && *forbidden != OPENCLAW_CONFIG_DIR)
    {
        assert!(!spec.arguments().iter().any(|value| value == forbidden));
        assert!(
            !spec
                .public_environment()
                .iter()
                .any(|(key, value)| key == forbidden || value == forbidden)
        );
    }
}

#[test]
fn bundled_bin_is_prepended_to_launch_path_environment() {
    let root = TestRoot::new();
    let bundled = root.working_directory.join("bin");
    fs::create_dir(&bundled).unwrap();
    let mut launch = input(&root).try_into_launch_factory().unwrap();

    let prepared = launch.prepare_attempt().unwrap();
    let inherited_path = select_path_environment(
        sanitize_inherited_environment(std::env::vars_os()),
        cfg!(windows),
    );
    let (key, current) = inherited_path.unwrap_or_else(|| (preferred_path_key(), OsString::new()));
    assert!(
        prepared
            .spec()
            .public_environment()
            .contains(&(key, prepend_path(&bundled, &current)))
    );
}

#[test]
fn missing_bundled_bin_preserves_inherited_path_environment() {
    let root = TestRoot::new();
    let inherited_path = select_path_environment(
        sanitize_inherited_environment(std::env::vars_os()),
        cfg!(windows),
    );
    let mut launch = input(&root).try_into_launch_factory().unwrap();

    let prepared = launch.prepare_attempt().unwrap();
    if let Some(inherited_path) = inherited_path {
        assert!(
            prepared
                .spec()
                .public_environment()
                .contains(&inherited_path)
        );
    } else {
        assert!(
            !prepared
                .spec()
                .public_environment()
                .iter()
                .any(|(key, _)| key.eq_ignore_ascii_case(OsStr::new(PATH_ENV)))
        );
    }
}

#[test]
fn bundled_bin_path_uses_packaged_layout_when_bin_exists() {
    let root = TestRoot::new();
    let packaged = root.working_directory.join("bin");
    fs::create_dir(&packaged).unwrap();

    assert_eq!(bundled_bin_path(&root.working_directory), Some(packaged));
}

#[test]
fn bundled_bin_path_uses_development_platform_architecture_layout() {
    let root = TestRoot::new();
    let development = root
        .working_directory
        .join("resources")
        .join("bin")
        .join(bundled_target_name().unwrap());
    fs::create_dir_all(&development).unwrap();

    assert_eq!(bundled_bin_path(&root.working_directory), Some(development));
}

#[test]
fn bundled_bin_path_is_absent_when_neither_layout_exists() {
    let root = TestRoot::new();

    assert_eq!(bundled_bin_path(&root.working_directory), None);
}

#[test]
fn bundled_target_name_matches_electron_architecture_names() {
    let platform = if cfg!(windows) {
        "win32"
    } else if cfg!(target_os = "macos") {
        "darwin"
    } else {
        "linux"
    };
    let architecture = if cfg!(target_arch = "aarch64") {
        "arm64"
    } else {
        "x64"
    };
    assert_eq!(
        bundled_target_name(),
        Some(format!("{platform}-{architecture}")),
    );
}

#[test]
fn inherited_path_selection_matches_legacy_key_precedence() {
    let environment = [
        (OsString::from("PaTh"), OsString::from("mixed")),
        (OsString::from("PATH"), OsString::from("upper")),
        (OsString::from("Path"), OsString::from("title")),
    ];

    assert_eq!(
        select_path_environment(environment.clone(), true),
        Some((OsString::from("Path"), OsString::from("title")))
    );
    assert_eq!(
        select_path_environment(environment, false),
        Some((OsString::from("PATH"), OsString::from("upper")))
    );
}

#[test]
fn inherited_path_selection_keeps_first_mixed_case_key() {
    let environment = [
        (OsString::from("PaTh"), OsString::from("first")),
        (OsString::from("pAtH"), OsString::from("second")),
    ];

    assert_eq!(
        select_path_environment(environment, true),
        Some((OsString::from("PaTh"), OsString::from("first")))
    );
}

#[test]
fn prepended_path_uses_platform_delimiter() {
    let entry = Path::new("/bundled/bin");
    let current = OsStr::new("/usr/bin");
    let value = prepend_path(entry, current);
    let expected = if cfg!(windows) {
        "/bundled/bin;/usr/bin"
    } else {
        "/bundled/bin:/usr/bin"
    };

    assert_eq!(value, OsString::from(expected));
}
