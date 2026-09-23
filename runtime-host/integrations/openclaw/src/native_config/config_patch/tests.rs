use std::{
    fs,
    path::PathBuf,
    sync::atomic::{AtomicU64, Ordering},
    time::{SystemTime, UNIX_EPOCH},
};

use super::*;

const SECRET_CANARY: &str = "synthetic-config-patch-secret-canary";
static NEXT_ROOT: AtomicU64 = AtomicU64::new(1);

struct TestRoot {
    path: PathBuf,
    state_dir: CanonicalStateDir,
}

impl TestRoot {
    fn new() -> Self {
        let sequence = NEXT_ROOT.fetch_add(1, Ordering::Relaxed);
        let nanos = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let path = std::env::temp_dir().join(format!(
            "openclaw-config-patch-{}-{nanos}-{sequence}",
            std::process::id()
        ));
        fs::create_dir(&path).unwrap();
        let state_dir = CanonicalStateDir::provision(path.join("state")).unwrap();
        Self { path, state_dir }
    }
}

impl Drop for TestRoot {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.path);
    }
}

fn absolute_path(name: &str) -> PathBuf {
    if cfg!(windows) {
        PathBuf::from(format!(r"C:\MatchaClaw\{name}"))
    } else {
        PathBuf::from(format!("/MatchaClaw/{name}"))
    }
}

fn patch() -> TelegramDefaultAccountProxyPatch {
    TelegramDefaultAccountProxyPatch::try_new("proxy.internal:8080").unwrap()
}

fn input(root: &TestRoot) -> TelegramDefaultAccountProxyInput {
    TelegramDefaultAccountProxyInput {
        electron_image: absolute_path("MatchaClaw"),
        openclaw_dir: absolute_path("openclaw"),
        entry: absolute_path("openclaw/openclaw.mjs"),
        state_dir: root.state_dir.clone(),
        patch: patch(),
    }
}

#[test]
fn builds_the_fixed_proxy_spec_with_exact_argv_environment_and_stdin() {
    let root = TestRoot::new();
    let spec = input(&root).try_into_spec().unwrap();

    assert_eq!(spec.executable, absolute_path("MatchaClaw"));
    assert_eq!(spec.working_directory, absolute_path("openclaw"));
    assert_eq!(
        spec.arguments,
        [
            absolute_path("openclaw/openclaw.mjs").into_os_string(),
            "config".into(),
            "patch".into(),
            "--stdin".into(),
        ]
    );
    assert_eq!(
        spec.environment,
        [
            (ELECTRON_RUN_AS_NODE.into(), "1".into()),
            (
                OPENCLAW_STATE_DIR.into(),
                root.state_dir.as_path().as_os_str().to_owned(),
            ),
            (
                OPENCLAW_CONFIG_PATH.into(),
                root.state_dir
                    .as_path()
                    .join(CANONICAL_CONFIG_FILE)
                    .into_os_string(),
            ),
        ]
    );
    assert_eq!(
        spec.stdin.0,
        br#"{"channels":{"telegram":{"defaultAccount":"default","accounts":{"default":{"proxy":"http://proxy.internal:8080"}}}}}"#
    );
    assert_eq!(spec.state_dir, root.state_dir);
}

#[test]
fn proxy_patch_normalizes_an_endpoint_without_a_scheme() {
    let patch = TelegramDefaultAccountProxyPatch::try_new("proxy.internal:8080").unwrap();

    assert_eq!(
        patch.0,
        br#"{"channels":{"telegram":{"defaultAccount":"default","accounts":{"default":{"proxy":"http://proxy.internal:8080"}}}}}"#
    );
}

#[test]
fn proxy_patch_preserves_a_valid_explicit_scheme() {
    let patch = TelegramDefaultAccountProxyPatch::try_new("socks5://proxy.internal:1080").unwrap();

    assert_eq!(
        patch.0,
        br#"{"channels":{"telegram":{"defaultAccount":"default","accounts":{"default":{"proxy":"socks5://proxy.internal:1080"}}}}}"#
    );
}

#[test]
fn proxy_patch_accepts_host_port_and_ipv6_endpoints() {
    for proxy in [
        "proxy.internal",
        "proxy.internal:8080",
        "https://proxy.internal:443",
        "socks5://[2001:db8::1]:1080",
    ] {
        TelegramDefaultAccountProxyPatch::try_new(proxy).unwrap();
    }
}

#[test]
fn proxy_patch_rejects_sensitive_or_malformed_endpoints_without_exposure() {
    let credential_bearing_proxy = format!("http://user:{SECRET_CANARY}@proxy.internal:8080");
    let cases = [
        "",
        "   ",
        " proxy.internal:8080 ",
        credential_bearing_proxy.as_str(),
        "http://@proxy.internal",
        "http://proxy.internal:",
        "http://proxy.internal:port",
        "http://proxy.internal:65536",
        "http:///missing-host",
        "http://[2001:db8::1",
        "http://[2001:db8::not-ip]:1080",
        "http://proxy.internal/path",
        "http://proxy.internal?query",
        "http://proxy.internal#fragment",
        "http://proxy\\internal",
        "http://proxy internal",
        "http://proxy.internal\u{0007}",
    ];
    for proxy in cases {
        let error = TelegramDefaultAccountProxyPatch::try_new(proxy).unwrap_err();

        assert_eq!(
            error,
            TelegramDefaultAccountProxyError::InvalidProxyEndpoint
        );
        assert_eq!(
            error.to_string(),
            "OpenClaw Telegram proxy endpoint is invalid"
        );
        assert!(!format!("{error:?} {error}").contains(SECRET_CANARY));
    }
    let error = TelegramDefaultAccountProxyPatch::try_new(&credential_bearing_proxy).unwrap_err();
    assert!(!format!("{error:?} {error}").contains(&credential_bearing_proxy));
}

#[test]
fn proxy_patch_rejects_serialized_stdin_over_the_native_limit_without_exposure() {
    let endpoint = "a".repeat(MAX_NATIVE_STDIN_BYTES);

    let error = TelegramDefaultAccountProxyPatch::try_new(&endpoint).unwrap_err();

    assert_eq!(error, TelegramDefaultAccountProxyError::PatchTooLarge);
    assert_eq!(
        error.to_string(),
        "OpenClaw Telegram proxy patch is too large"
    );
    assert!(!format!("{error:?} {error}").contains(&endpoint));
}

#[test]
fn rejects_a_state_directory_replaced_after_provisioning_without_exposure() {
    let root = TestRoot::new();
    let state_path = root.state_dir.as_path().to_owned();
    fs::remove_dir(&state_path).unwrap();
    fs::create_dir(&state_path).unwrap();

    let error = input(&root).try_into_spec().unwrap_err();

    assert_eq!(error, TelegramDefaultAccountProxyError::InvalidInput);
    assert_eq!(
        error.to_string(),
        "OpenClaw Telegram proxy input is invalid"
    );
    assert!(!format!("{error:?} {error}").contains(state_path.to_string_lossy().as_ref()));
}

#[test]
fn rejects_noncanonical_launch_inputs_without_exposing_them() {
    for mutate in [
        |input: &mut TelegramDefaultAccountProxyInput| input.electron_image = SECRET_CANARY.into(),
        |input: &mut TelegramDefaultAccountProxyInput| input.openclaw_dir = SECRET_CANARY.into(),
        |input: &mut TelegramDefaultAccountProxyInput| {
            input.entry = absolute_path("other/openclaw.mjs")
        },
        |input: &mut TelegramDefaultAccountProxyInput| {
            input.entry = absolute_path("openclaw/alternate.mjs")
        },
        |input: &mut TelegramDefaultAccountProxyInput| {
            input.openclaw_dir = absolute_path("openclaw/./")
        },
        |input: &mut TelegramDefaultAccountProxyInput| {
            input.openclaw_dir = absolute_path("openclaw/../openclaw")
        },
        |input: &mut TelegramDefaultAccountProxyInput| {
            input.entry = absolute_path("openclaw/./openclaw.mjs")
        },
        |input: &mut TelegramDefaultAccountProxyInput| {
            input.entry = absolute_path("openclaw/../openclaw/openclaw.mjs")
        },
        |input: &mut TelegramDefaultAccountProxyInput| input.entry = SECRET_CANARY.into(),
    ] {
        let root = TestRoot::new();
        let mut candidate = input(&root);
        mutate(&mut candidate);

        let error = candidate.try_into_spec().unwrap_err();

        assert_eq!(error, TelegramDefaultAccountProxyError::InvalidInput);
        assert_eq!(
            error.to_string(),
            "OpenClaw Telegram proxy input is invalid"
        );
        assert!(!format!("{error:?} {error}").contains(SECRET_CANARY));
    }
}

#[test]
fn rejects_curdir_and_parentdir_launch_path_components() {
    for (openclaw_dir, entry) in [
        ("openclaw/./", "openclaw/./openclaw.mjs"),
        ("openclaw/../openclaw", "openclaw/../openclaw/openclaw.mjs"),
    ] {
        let root = TestRoot::new();
        let mut candidate = input(&root);
        candidate.openclaw_dir = absolute_path(openclaw_dir);
        candidate.entry = absolute_path(entry);

        assert_eq!(
            candidate.try_into_spec().unwrap_err(),
            TelegramDefaultAccountProxyError::InvalidInput
        );
    }
}

#[test]
fn errors_and_specs_redact_proxy_contents_and_paths() {
    let root = TestRoot::new();
    let spec = input(&root).try_into_spec().unwrap();

    let rendered = format!("{spec:?} {:?}", spec.stdin);
    assert_eq!(
        format!("{spec:?}"),
        "TelegramDefaultAccountProxySpec([REDACTED])"
    );
    assert_eq!(
        format!("{:?}", spec.stdin),
        "TelegramDefaultAccountProxyPatch([REDACTED])"
    );
    assert!(!rendered.contains("proxy.internal"));
    assert!(!rendered.contains(root.state_dir.as_path().to_string_lossy().as_ref()));
}
