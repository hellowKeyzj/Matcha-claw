use std::{fmt, sync::Arc};

use foundation::toolchain as native_toolchain;
pub use foundation::toolchain::{
    FoundationToolchainCommandPort, NativeToolchainRuntime, NativeToolchainRuntimeError,
    ToolchainCommandFuture, ToolchainCommandOutcome, ToolchainCommandPort, ToolchainCommandRequest,
    ToolchainPlatform, UnsupportedToolchainCommandPort,
};
use serde::Serialize;

use crate::{lifecycle::state_dir::CanonicalStateDir, projection::tool_permission};

const UV_TOOL_ID: &str = "uv";
const PYTHON_TOOL_ID: &str = "python-3.12";

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum ToolAvailability {
    Available,
    Unavailable,
    Unknown,
    Unsupported,
}

impl From<native_toolchain::ToolAvailability> for ToolAvailability {
    fn from(availability: native_toolchain::ToolAvailability) -> Self {
        match availability {
            native_toolchain::ToolAvailability::Available => Self::Available,
            native_toolchain::ToolAvailability::Unavailable => Self::Unavailable,
            native_toolchain::ToolAvailability::Unknown => Self::Unknown,
            native_toolchain::ToolAvailability::Unsupported => Self::Unsupported,
        }
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum PythonReadiness {
    Ready,
    NotReady,
    Unknown,
    Unavailable,
    Unsupported,
}

impl From<native_toolchain::PythonReadiness> for PythonReadiness {
    fn from(readiness: native_toolchain::PythonReadiness) -> Self {
        match readiness {
            native_toolchain::PythonReadiness::Ready => Self::Ready,
            native_toolchain::PythonReadiness::NotReady => Self::NotReady,
            native_toolchain::PythonReadiness::Unknown => Self::Unknown,
            native_toolchain::PythonReadiness::Unavailable => Self::Unavailable,
            native_toolchain::PythonReadiness::Unsupported => Self::Unsupported,
        }
    }
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ToolchainStatus {
    uv: ToolAvailability,
    python: PythonReadiness,
}

impl ToolchainStatus {
    pub fn uv(&self) -> ToolAvailability {
        self.uv
    }

    pub fn python(&self) -> PythonReadiness {
        self.python
    }
}

impl From<native_toolchain::ToolchainStatus> for ToolchainStatus {
    fn from(status: native_toolchain::ToolchainStatus) -> Self {
        Self {
            uv: status.uv().into(),
            python: status.python().into(),
        }
    }
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ToolchainCatalog {
    entries: Vec<ToolchainEntry>,
}

impl ToolchainCatalog {
    pub fn entries(&self) -> &[ToolchainEntry] {
        &self.entries
    }
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ToolchainEntry {
    id: String,
    status: ToolAvailability,
}

impl ToolchainEntry {
    pub fn id(&self) -> &str {
        &self.id
    }

    pub fn status(&self) -> ToolAvailability {
        self.status
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum UvInstallOutcome {
    Installed,
    Rejected,
    Unknown,
    Unavailable,
    Unsupported,
}

impl From<native_toolchain::UvInstallOutcome> for UvInstallOutcome {
    fn from(outcome: native_toolchain::UvInstallOutcome) -> Self {
        match outcome {
            native_toolchain::UvInstallOutcome::Installed => Self::Installed,
            native_toolchain::UvInstallOutcome::Rejected => Self::Rejected,
            native_toolchain::UvInstallOutcome::Unknown => Self::Unknown,
            native_toolchain::UvInstallOutcome::Unavailable => Self::Unavailable,
            native_toolchain::UvInstallOutcome::Unsupported => Self::Unsupported,
        }
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum PermissionReadOutcome {
    Observed(tool_permission::Mode),
    Unavailable,
    Unknown,
    Unsupported,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum PermissionWriteOutcome {
    Unchanged,
    Written,
    Unavailable,
    Unknown,
    Unsupported,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum ToolchainWriteRequest {
    Permission(tool_permission::Mode),
    InstallUv,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum ToolchainWriteOutcome {
    Permission(PermissionWriteOutcome),
    InstallUv(UvInstallOutcome),
}

/// OpenClaw Integration owner for public Toolchain projection and the existing config permission owner.
pub struct OpenClawToolchain {
    state_dir: CanonicalStateDir,
    runtime: Arc<NativeToolchainRuntime>,
}

impl OpenClawToolchain {
    pub fn new(
        state_dir: CanonicalStateDir,
        runtime: impl Into<Arc<NativeToolchainRuntime>>,
    ) -> Self {
        Self {
            state_dir,
            runtime: runtime.into(),
        }
    }

    pub async fn read(&self) -> ToolchainStatus {
        self.status().await
    }

    pub async fn status(&self) -> ToolchainStatus {
        self.runtime.observe().await.into()
    }

    pub async fn list(&self) -> ToolchainCatalog {
        catalog_from_status(self.status().await)
    }

    pub fn read_permission(&self) -> PermissionReadOutcome {
        match tool_permission::Mode::read(self.state_dir.clone()) {
            Ok(mode) => PermissionReadOutcome::Observed(mode),
            Err(tool_permission::Error::Unavailable) => PermissionReadOutcome::Unavailable,
            Err(tool_permission::Error::Unknown) => PermissionReadOutcome::Unknown,
        }
    }

    pub fn write_permission(&self, mode: tool_permission::Mode) -> PermissionWriteOutcome {
        match mode.apply(self.state_dir.clone()) {
            Ok(tool_permission::Effect::Unchanged) => PermissionWriteOutcome::Unchanged,
            Ok(tool_permission::Effect::Written) => PermissionWriteOutcome::Written,
            Err(tool_permission::Error::Unavailable) => PermissionWriteOutcome::Unavailable,
            Err(tool_permission::Error::Unknown) => PermissionWriteOutcome::Unknown,
        }
    }

    pub async fn install_uv(&self) -> UvInstallOutcome {
        self.runtime.install_uv().await.into()
    }

    pub async fn write(&self, request: ToolchainWriteRequest) -> ToolchainWriteOutcome {
        match request {
            ToolchainWriteRequest::Permission(mode) => {
                ToolchainWriteOutcome::Permission(self.write_permission(mode))
            }
            ToolchainWriteRequest::InstallUv => {
                ToolchainWriteOutcome::InstallUv(self.install_uv().await)
            }
        }
    }
}

impl fmt::Debug for OpenClawToolchain {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("OpenClawToolchain([REDACTED])")
    }
}

fn catalog_from_status(status: ToolchainStatus) -> ToolchainCatalog {
    ToolchainCatalog {
        entries: vec![
            ToolchainEntry {
                id: UV_TOOL_ID.to_owned(),
                status: status.uv,
            },
            ToolchainEntry {
                id: PYTHON_TOOL_ID.to_owned(),
                status: match status.python {
                    PythonReadiness::Ready => ToolAvailability::Available,
                    PythonReadiness::NotReady => ToolAvailability::Unavailable,
                    PythonReadiness::Unknown => ToolAvailability::Unknown,
                    PythonReadiness::Unavailable => ToolAvailability::Unavailable,
                    PythonReadiness::Unsupported => ToolAvailability::Unsupported,
                },
            },
        ],
    }
}

#[cfg(test)]
mod tests {
    use std::{
        fs,
        path::PathBuf,
        sync::atomic::{AtomicU64, Ordering},
        time::{SystemTime, UNIX_EPOCH},
    };

    use serde_json::json;

    use super::*;

    static NEXT_TEST_ID: AtomicU64 = AtomicU64::new(1);

    struct TestRoot {
        path: PathBuf,
        state_dir: CanonicalStateDir,
    }

    impl TestRoot {
        fn new() -> Self {
            let sequence = NEXT_TEST_ID.fetch_add(1, Ordering::Relaxed);
            let nanos = SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .expect("test clock must follow Unix epoch")
                .as_nanos();
            let path = std::env::temp_dir().join(format!("openclaw-toolchain-{nanos}-{sequence}"));
            fs::create_dir_all(&path).unwrap();
            let state_dir = CanonicalStateDir::provision(path.join("state")).unwrap();
            Self { path, state_dir }
        }
    }

    impl Drop for TestRoot {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.path);
        }
    }

    #[test]
    fn native_toolchain_facts_project_to_openclaw_public_categories() {
        assert_eq!(
            ToolAvailability::from(native_toolchain::ToolAvailability::Available),
            ToolAvailability::Available
        );
        assert_eq!(
            ToolAvailability::from(native_toolchain::ToolAvailability::Unavailable),
            ToolAvailability::Unavailable
        );
        assert_eq!(
            ToolAvailability::from(native_toolchain::ToolAvailability::Unknown),
            ToolAvailability::Unknown
        );
        assert_eq!(
            ToolAvailability::from(native_toolchain::ToolAvailability::Unsupported),
            ToolAvailability::Unsupported
        );
        assert_eq!(
            PythonReadiness::from(native_toolchain::PythonReadiness::Ready),
            PythonReadiness::Ready
        );
        assert_eq!(
            PythonReadiness::from(native_toolchain::PythonReadiness::NotReady),
            PythonReadiness::NotReady
        );
        assert_eq!(
            PythonReadiness::from(native_toolchain::PythonReadiness::Unknown),
            PythonReadiness::Unknown
        );
        assert_eq!(
            PythonReadiness::from(native_toolchain::PythonReadiness::Unavailable),
            PythonReadiness::Unavailable
        );
        assert_eq!(
            PythonReadiness::from(native_toolchain::PythonReadiness::Unsupported),
            PythonReadiness::Unsupported
        );
    }

    #[test]
    fn uv_install_outcomes_project_to_openclaw_public_categories() {
        assert_eq!(
            UvInstallOutcome::from(native_toolchain::UvInstallOutcome::Installed),
            UvInstallOutcome::Installed
        );
        assert_eq!(
            UvInstallOutcome::from(native_toolchain::UvInstallOutcome::Rejected),
            UvInstallOutcome::Rejected
        );
        assert_eq!(
            UvInstallOutcome::from(native_toolchain::UvInstallOutcome::Unknown),
            UvInstallOutcome::Unknown
        );
        assert_eq!(
            UvInstallOutcome::from(native_toolchain::UvInstallOutcome::Unavailable),
            UvInstallOutcome::Unavailable
        );
        assert_eq!(
            UvInstallOutcome::from(native_toolchain::UvInstallOutcome::Unsupported),
            UvInstallOutcome::Unsupported
        );
    }

    #[test]
    fn list_exposes_only_openclaw_public_tool_facts() {
        let catalog = catalog_from_status(ToolchainStatus {
            uv: ToolAvailability::Unknown,
            python: PythonReadiness::Unknown,
        });

        assert_eq!(
            serde_json::to_value(&catalog).unwrap(),
            json!({
                "entries": [
                    { "id": "uv", "status": "unknown" },
                    { "id": "python-3.12", "status": "unknown" }
                ]
            })
        );
    }

    #[tokio::test]
    async fn permission_read_write_uses_the_existing_permission_owner_and_readback() {
        let root = TestRoot::new();
        let runtime = NativeToolchainRuntime::new(
            ToolchainPlatform::Unix,
            "x64",
            root.path.clone(),
            None,
            std::sync::Arc::new(UnsupportedToolchainCommandPort),
        );
        let owner = OpenClawToolchain::new(root.state_dir.clone(), runtime);

        assert_eq!(
            owner.read_permission(),
            PermissionReadOutcome::Observed(tool_permission::Mode::FullAccess)
        );
        assert_eq!(
            owner
                .write(ToolchainWriteRequest::Permission(
                    tool_permission::Mode::Default
                ))
                .await,
            ToolchainWriteOutcome::Permission(PermissionWriteOutcome::Written)
        );
        assert_eq!(
            owner.read_permission(),
            PermissionReadOutcome::Observed(tool_permission::Mode::Default)
        );
        assert_eq!(
            owner.write_permission(tool_permission::Mode::Default),
            PermissionWriteOutcome::Unchanged
        );
    }

    #[test]
    fn permission_outcomes_retain_unavailable_unknown_and_unsupported_categories() {
        assert_eq!(
            PermissionWriteOutcome::Unavailable,
            PermissionWriteOutcome::Unavailable
        );
        assert_eq!(
            PermissionWriteOutcome::Unknown,
            PermissionWriteOutcome::Unknown
        );
        assert_eq!(
            PermissionWriteOutcome::Unsupported,
            PermissionWriteOutcome::Unsupported
        );
        assert_eq!(
            PermissionReadOutcome::Unknown,
            PermissionReadOutcome::Unknown
        );
        assert_eq!(
            PermissionReadOutcome::Unsupported,
            PermissionReadOutcome::Unsupported
        );
    }

    #[test]
    fn debug_output_does_not_expose_runtime_details() {
        let root = TestRoot::new();
        let runtime = NativeToolchainRuntime::new(
            ToolchainPlatform::Unix,
            "x64",
            root.path.clone(),
            None,
            std::sync::Arc::new(UnsupportedToolchainCommandPort),
        );
        let owner = OpenClawToolchain::new(root.state_dir.clone(), runtime);

        assert_eq!(format!("{owner:?}"), "OpenClawToolchain([REDACTED])");
    }
}
