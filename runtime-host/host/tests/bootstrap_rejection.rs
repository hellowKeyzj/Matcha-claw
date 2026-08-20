use std::{
    io::Write,
    process::{Command, Stdio},
};

#[test]
fn rejects_unknown_bootstrap_fields_without_echoing_their_contents() {
    assert_rejected(
        r#"{"version":1,"unexpected":"bootstrap-sentinel-must-not-appear"}"#,
        "bootstrap-sentinel-must-not-appear",
    );
}

#[test]
fn rejects_the_legacy_parent_bootstrap_field_without_echoing_its_contents() {
    assert_rejected(
        r#"{"version":1,"parent":{"marker":"legacy-parent-must-not-appear"}}"#,
        "legacy-parent-must-not-appear",
    );
}

fn assert_rejected(payload: &str, marker: &str) {
    let mut child = Command::new(env!("CARGO_BIN_EXE_runtime-host"))
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .unwrap();
    let mut input = child.stdin.take().unwrap();
    input
        .write_all(&(payload.len() as u32).to_be_bytes())
        .unwrap();
    input.write_all(payload.as_bytes()).unwrap();
    drop(input);

    let output = child.wait_with_output().unwrap();

    assert!(!output.status.success());
    assert!(output.stdout.is_empty());
    assert!(!String::from_utf8_lossy(&output.stderr).contains(marker));
}
