//! Static evidence for the application-owned local OpenClaw installation.

use std::{fs::File, io::Read, path::Path};

use serde_json::{Value, json};
use tokio::sync::Semaphore;

mod configuration;
mod storage;

const MAX_DOCUMENT_BYTES: u64 = 1_048_576;
const MAX_ITEMS: usize = 64;
// Keep the permit in the worker: cancelling its caller must not admit more blocking reads.
// ponytail: one global inspection; use per-driver admission if concurrent instances become real.
static INSPECTION: Semaphore = Semaphore::const_new(1);

/// Reads bounded local evidence, not native schema validation or runtime health.
pub async fn inspect(driver: &crate::driver::OpenClawDriver) -> Value {
    let Ok(permit) = INSPECTION.try_acquire() else {
        return json!({"status": "busy", "reason": "inspectionInProgress"});
    };
    let state_dir = driver.state_dir.clone();
    let openclaw_dir = driver.openclaw_dir.clone();
    let electron_image = driver.electron_image.clone();
    let gateway_port = driver.gateway_port;
    tokio::task::spawn_blocking(move || {
        let _permit = permit;
        let package = package(&openclaw_dir.join("package.json"));
        let configuration = configuration::inspect(&state_dir, &openclaw_dir);
        let storage = storage::inspect(state_dir.as_path(), &configuration, &package);
        json!({
            "status": "inspected",
            "target": "applicationLocalOpenClaw",
            "paths": {
                "installation": openclaw_dir,
                "state": state_dir.as_path(),
                "config": state_dir.as_path().join("openclaw.json"),
                "gatewayCwd": openclaw_dir,
                "executable": electron_image,
                "packageEntry": file_evidence(&openclaw_dir.join("openclaw.mjs")),
                "actualLaunchEntry": {"status": "unavailable", "reason": "notRetainedByDriver"}
            },
            "launch": {"gatewayPort": gateway_port, "portSource": "driver", "authentication": "driverOwnedNotInspected"},
            "package": package,
            "configuration": configuration.summary,
            "storage": storage,
            "coverage": {
                "kind": "staticReadOnlyEvidence",
                "nativeSchemaValidation": "notPerformed",
                "runtimeHealth": "notChecked",
                "upstreamCodeExecuted": false,
                "snapshot": "perFileAndPerDatabaseNotAtomicAcrossFiles"
            }
        })
    })
    .await
    .unwrap_or_else(|_| json!({"status": "unavailable", "reason": "inspectionWorkerFailed"}))
}

fn package(path: &Path) -> Value {
    let mut evidence = file_evidence(path);
    let read = || -> Result<Value, &'static str> {
        let file = File::open(path).map_err(|error| io_status(&error))?;
        if !file
            .metadata()
            .map_err(|error| io_status(&error))?
            .is_file()
        {
            return Err("notRegularFile");
        }
        let mut bytes = Vec::new();
        file.take(MAX_DOCUMENT_BYTES + 1)
            .read_to_end(&mut bytes)
            .map_err(|error| io_status(&error))?;
        if bytes.len() as u64 > MAX_DOCUMENT_BYTES {
            return Err("tooLarge");
        }
        let document: Value = serde_json::from_slice(&bytes).map_err(|_| "invalidJson")?;
        if !document.is_object() {
            return Err("notObject");
        }
        Ok(json!({
            "version": document.get("version").and_then(version),
            "schemaVersions": {
                "state": document.pointer("/openclaw/schemaVersions/state").and_then(Value::as_u64),
                "agent": document.pointer("/openclaw/schemaVersions/agent").and_then(Value::as_u64)
            }
        }))
    };
    match read() {
        Ok(summary) => {
            evidence["status"] = json!("parsed");
            evidence["version"] = summary["version"].clone();
            evidence["schemaVersions"] = summary["schemaVersions"].clone();
        }
        Err(status) => evidence["status"] = json!(status),
    }
    evidence
}

pub(super) fn file_evidence(path: &Path) -> Value {
    match std::fs::metadata(path) {
        Ok(metadata) => json!({
            "path": path,
            "status": if metadata.is_file() { "present" } else { "notRegularFile" },
            "exists": true,
            "sizeBytes": metadata.len()
        }),
        Err(error) => json!({
            "path": path,
            "status": io_status(&error),
            "exists": if error.kind() == std::io::ErrorKind::NotFound { Some(false) } else { None }
        }),
    }
}

pub(super) fn io_status(error: &std::io::Error) -> &'static str {
    match error.kind() {
        std::io::ErrorKind::NotFound => "missing",
        std::io::ErrorKind::PermissionDenied => "permissionDenied",
        _ => "ioError",
    }
}

pub(super) fn version(value: &Value) -> Option<&str> {
    value.as_str().filter(|text| {
        !text.is_empty()
            && text.len() <= 128
            && text
                .bytes()
                .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'+' | b'-'))
    })
}

pub(super) fn label(value: &str) -> Value {
    if !value.is_empty()
        && value.len() <= 256
        && value.bytes().all(|byte| {
            byte.is_ascii_alphanumeric()
                || matches!(byte, b'.' | b'_' | b'-' | b'/' | b':' | b'@' | b'+')
        })
    {
        json!(value)
    } else {
        json!({"status": "omitted", "reason": "notBoundedIdentifier"})
    }
}
