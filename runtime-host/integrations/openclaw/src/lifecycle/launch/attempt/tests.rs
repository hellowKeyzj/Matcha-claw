use super::*;

#[test]
fn debug_output_redacts_state_directory() {
    let files = AttemptFiles { state_dir: None };

    assert_eq!(format!("{files:?}"), "AttemptFiles(<redacted>)");
}
