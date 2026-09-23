use std::path::Path;

use serde::Serialize;

use crate::package_status;

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Status {
    package_exists: bool,
    is_built: bool,
    dir: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    version: Option<String>,
}

impl Status {
    pub fn inspect(openclaw_dir: &Path) -> Option<Self> {
        let dir = openclaw_dir
            .to_str()
            .filter(|dir| !dir.is_empty())
            .map(ToOwned::to_owned)?;
        let environment = package_status::Status::inspect(openclaw_dir);

        Some(Self {
            package_exists: environment.package_exists(),
            is_built: environment.is_built(),
            dir,
            version: environment
                .version()
                .filter(is_safe_version)
                .map(ToOwned::to_owned),
        })
    }

    pub fn package_exists(&self) -> bool {
        self.package_exists
    }

    pub fn is_built(&self) -> bool {
        self.is_built
    }

    pub fn dir(&self) -> &str {
        &self.dir
    }

    pub fn version(&self) -> Option<&str> {
        self.version.as_deref()
    }
}

fn is_safe_version(value: &&str) -> bool {
    !value.is_empty()
        && value.len() <= 128
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'+' | b'-'))
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

    struct Directory(PathBuf);

    impl Directory {
        fn new() -> Self {
            let ordinal = NEXT_TEST_ID.fetch_add(1, Ordering::Relaxed);
            let nanos = SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .expect("test clock must follow Unix epoch")
                .as_nanos();
            let path = std::env::temp_dir().join(format!(
                "runtime-host-openclaw-installation-{ordinal}-{nanos}"
            ));
            fs::create_dir_all(&path).unwrap();
            Self(path)
        }
    }

    impl Drop for Directory {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    #[test]
    fn status_combines_installation_directory_with_environment_facts() {
        let directory = Directory::new();
        fs::write(
            directory.0.join("package.json"),
            r#"{ "version": "1.2.3" }"#,
        )
        .unwrap();
        fs::create_dir(directory.0.join("dist")).unwrap();

        assert_eq!(
            serde_json::to_value(Status::inspect(&directory.0).unwrap()).unwrap(),
            json!({
                "packageExists": true,
                "isBuilt": true,
                "dir": directory.0.to_str().unwrap(),
                "version": "1.2.3",
            })
        );
    }

    #[test]
    fn status_preserves_environment_status_without_exposing_configuration() {
        let directory = Directory::new();

        let encoded = serde_json::to_value(Status::inspect(&directory.0).unwrap()).unwrap();

        assert_eq!(
            encoded,
            json!({
                "packageExists": false,
                "isBuilt": false,
                "dir": directory.0.to_str().unwrap(),
            })
        );
        let rendered = encoded.to_string();
        for private in ["openclaw.json", "token", "secret", "endpoint", "argv"] {
            assert!(!rendered.contains(private));
        }
    }
}
