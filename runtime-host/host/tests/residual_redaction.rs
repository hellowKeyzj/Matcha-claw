use std::{fs, path::Path};

const SOURCE_ROOTS: &[&str] = &[
    "src",
    "../domains/environment/src",
    "../integrations/openclaw/src",
];

#[test]
fn removed_runtime_job_surface_stays_out_of_production_sources() {
    let removed = [
        "RuntimeJob",
        "runtimeHost.jobGet",
        "runtime-job",
        "job_compatibility",
    ];

    assert_no_source_contains("removed runtime job surface", |path, source| {
        if removed.iter().any(|token| source.contains(token)) {
            Some(format!(
                "{} contains removed runtime job surface",
                path.display()
            ))
        } else {
            None
        }
    });
}

#[test]
fn public_responses_do_not_return_raw_policy_or_native_owner_values() {
    assert_no_source_contains("raw public response", |path, source| {
        for (line_number, line) in source.lines().enumerate() {
            if line.contains("Response::ok(")
                && contains_any(line, &["raw", "policy", "native", "owner"])
            {
                return Some(format!(
                    "{}:{} returns raw/policy/native/owner value",
                    path.display(),
                    line_number + 1
                ));
            }
            if line.contains("serde_json::to_value")
                && contains_any(line, &["owner", "native"])
                && contains_any(line, &["Response", "response", "body"])
            {
                return Some(format!(
                    "{}:{} serializes whole owner/native value for response",
                    path.display(),
                    line_number + 1
                ));
            }
        }
        None
    });
}

#[test]
fn logs_do_not_print_sensitive_runtime_fields() {
    let log_markers = [
        "eprintln!(",
        "println!(",
        "dbg!(",
        "tracing::warn!(",
        "tracing::info!(",
        "tracing::debug!(",
        "tracing::error!(",
        "tracing::trace!(",
        "log::warn!(",
        "log::info!(",
        "log::debug!(",
        "log::error!(",
        "log::trace!(",
        "warn!(",
        "info!(",
        "debug!(",
        "error!(",
        "trace!(",
    ];
    let sensitive = ["token", "path", "sessionKey", "rawPayload"];

    assert_no_source_contains("sensitive logging", |path, source| {
        for (line_number, line) in source.lines().enumerate() {
            if contains_any(line, &log_markers) && contains_any(line, &sensitive) {
                return Some(format!(
                    "{}:{} logs a sensitive runtime field",
                    path.display(),
                    line_number + 1
                ));
            }
        }
        None
    });
}

fn assert_no_source_contains(label: &str, mut inspect: impl FnMut(&Path, &str) -> Option<String>) {
    let manifest_dir = Path::new(env!("CARGO_MANIFEST_DIR"));
    let mut violations = Vec::new();
    for root in SOURCE_ROOTS {
        visit_rs_files(&manifest_dir.join(root), &mut |path| {
            let source = fs::read_to_string(path)
                .unwrap_or_else(|error| panic!("failed to read {}: {error}", path.display()));
            if let Some(violation) = inspect(path, &source) {
                violations.push(violation);
            }
        });
    }

    assert!(
        violations.is_empty(),
        "{label} violations:\n{}",
        violations.join("\n")
    );
}

fn visit_rs_files(root: &Path, visit: &mut impl FnMut(&Path)) {
    let entries = fs::read_dir(root)
        .unwrap_or_else(|error| panic!("failed to read {}: {error}", root.display()));
    for entry in entries {
        let entry = entry.expect("source directory entry is readable");
        let path = entry.path();
        if path.is_dir() {
            let Some(name) = path.file_name().and_then(|name| name.to_str()) else {
                continue;
            };
            if name == "tests" || name == "docs" {
                continue;
            }
            visit_rs_files(&path, visit);
        } else if path.extension().is_some_and(|extension| extension == "rs")
            && !path
                .file_name()
                .and_then(|name| name.to_str())
                .is_some_and(|name| name == "tests.rs" || name.ends_with("_tests.rs"))
        {
            visit(&path);
        }
    }
}

fn contains_any(line: &str, needles: &[&str]) -> bool {
    needles.iter().any(|needle| line.contains(needle))
}
