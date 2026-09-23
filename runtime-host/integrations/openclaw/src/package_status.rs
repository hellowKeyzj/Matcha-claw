use std::{fs, path::Path};

use serde::Serialize;

const PACKAGE_FILE: &str = "package.json";
const BUILD_DIRECTORY: &str = "dist";

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Status {
    package_exists: bool,
    is_built: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    version: Option<String>,
}

impl Status {
    pub fn inspect(openclaw_dir: &Path) -> Self {
        let package_path = openclaw_dir.join(PACKAGE_FILE);
        let package_exists = openclaw_dir.is_dir() && package_path.is_file();
        let is_built = openclaw_dir.join(BUILD_DIRECTORY).is_dir();
        let version = package_exists
            .then(|| read_version(&package_path))
            .flatten();

        Self {
            package_exists,
            is_built,
            version,
        }
    }

    pub(crate) fn package_exists(&self) -> bool {
        self.package_exists
    }

    pub(crate) fn is_built(&self) -> bool {
        self.is_built
    }

    pub(crate) fn version(&self) -> Option<&str> {
        self.version.as_deref()
    }
}

fn read_version(package_path: &Path) -> Option<String> {
    let source = fs::read_to_string(package_path).ok()?;
    let package = serde_json::from_str::<serde_json::Value>(&source).ok()?;
    package
        .get("version")
        .and_then(serde_json::Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(ToOwned::to_owned)
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
                "runtime-host-openclaw-package-status-{ordinal}-{nanos}"
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
    fn status_matches_package_and_build_layout_without_path_projection() {
        let directory = Directory::new();
        fs::write(directory.0.join(PACKAGE_FILE), r#"{ "version": "1.2.3" }"#).unwrap();
        fs::create_dir(directory.0.join(BUILD_DIRECTORY)).unwrap();

        let encoded = serde_json::to_value(Status::inspect(&directory.0)).unwrap();

        assert_eq!(
            encoded,
            json!({
                "packageExists": true,
                "isBuilt": true,
                "version": "1.2.3",
            })
        );
        assert!(
            !encoded
                .to_string()
                .contains(directory.0.to_string_lossy().as_ref())
        );
    }

    #[test]
    fn status_keeps_missing_package_and_invalid_version_non_fatal() {
        let missing = Directory::new();
        assert_eq!(
            serde_json::to_value(Status::inspect(&missing.0)).unwrap(),
            json!({ "packageExists": false, "isBuilt": false }),
        );

        fs::write(missing.0.join(PACKAGE_FILE), "not-json").unwrap();
        fs::create_dir(missing.0.join(BUILD_DIRECTORY)).unwrap();
        assert_eq!(
            serde_json::to_value(Status::inspect(&missing.0)).unwrap(),
            json!({ "packageExists": true, "isBuilt": true }),
        );
    }

    #[test]
    fn status_requires_the_expected_layout_node_types() {
        let directory = Directory::new();
        fs::create_dir(directory.0.join(PACKAGE_FILE)).unwrap();
        fs::write(directory.0.join(BUILD_DIRECTORY), "not-a-directory").unwrap();

        assert_eq!(
            serde_json::to_value(Status::inspect(&directory.0)).unwrap(),
            json!({ "packageExists": false, "isBuilt": false }),
        );
    }
}
