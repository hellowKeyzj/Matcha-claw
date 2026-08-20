use std::{
    ffi::{OsStr, OsString},
    os::windows::ffi::{OsStrExt, OsStringExt},
    process::Command,
    thread,
    time::{Duration, Instant},
};

use super::{
    super::{
        super::super::{LaunchSpec, StdioMode, StdioSpec},
        custody,
        test_support::TestDirectory,
    },
    checked_environment_block_length, checked_environment_key_length, compare_environment_keys,
    environment_block, environment_ptr, quote,
};

const EXACT_ENVIRONMENT_TEST: &str =
    "process::system::windows::command::tests::exact_environment_does_not_inherit_host_environment";
const EMPTY_ENVIRONMENT_TEST: &str =
    "process::system::windows::command::tests::empty_environment_does_not_inherit_host_environment";
const EMPTY_CHILD_MARKER: &str = "empty-environment-child";
const HOST_ROLE: &str = "MATCHA_WINDOWS_EXACT_ENV_TEST_ROLE";
const HOST_ONLY_KEY: &str = "MATCHA_WINDOWS_EXACT_ENV_HOST_ONLY";
const UNICODE_KEY: &str = "MATCHA_环境";
const UNICODE_VALUE: &str = "精确投影";

fn utf16(units: &[u16]) -> String {
    String::from_utf16(units).expect("test input is valid UTF-16")
}

fn environment_entries(block: &[u16]) -> Vec<String> {
    block
        .split(|unit| *unit == 0)
        .filter(|entry| !entry.is_empty())
        .map(utf16)
        .collect()
}

fn os_string_with_nul(prefix: &str) -> OsString {
    let mut units: Vec<u16> = prefix.encode_utf16().collect();
    units.push(0);
    units.push(u16::from(b'x'));
    OsString::from_wide(&units)
}

#[test]
fn quotes_spaces_embedded_quotes_and_trailing_backslashes() {
    let mut spaced = Vec::new();
    quote(OsString::from("a b").as_os_str(), &mut spaced).unwrap();
    assert_eq!(utf16(&spaced), "\"a b\"");

    let mut embedded_quote = Vec::new();
    quote(OsString::from("a\"b").as_os_str(), &mut embedded_quote).unwrap();
    assert_eq!(utf16(&embedded_quote), "\"a\\\"b\"");

    let mut trailing_backslash = Vec::new();
    quote(OsString::from("a b\\").as_os_str(), &mut trailing_backslash).unwrap();
    assert_eq!(utf16(&trailing_backslash), "\"a b\\\\\"");
}

#[test]
fn empty_environment_is_an_explicit_non_null_double_nul_block() {
    let block = environment_block(&[]).unwrap();

    assert_eq!(block, [0, 0]);
    assert!(!environment_ptr(&block).is_null());
}

#[test]
fn environment_block_preserves_exact_unicode_entries_and_empty_values() {
    let block = environment_block(&[
        (OsString::from("变量"), OsString::from("值=一")),
        (OsString::from("EMPTY"), OsString::new()),
    ])
    .unwrap();

    let entries = environment_entries(&block);
    assert_eq!(entries.len(), 2);
    assert!(entries.iter().any(|entry| entry == "EMPTY="));
    assert!(entries.iter().any(|entry| entry == "变量=值=一"));
    assert_eq!(block.last(), Some(&0));
    assert_eq!(block[block.len() - 2], 0);
}

#[test]
fn environment_block_rejects_invalid_keys_and_nul_values() {
    for key in [
        OsString::new(),
        OsString::from("A=B"),
        OsString::from("=C:"),
        os_string_with_nul("KEY"),
    ] {
        assert!(environment_block(&[(key, OsString::from("value"))]).is_err());
    }

    assert!(environment_block(&[(OsString::from("KEY"), os_string_with_nul("value"))]).is_err());
}

#[test]
fn environment_block_length_checks_overflow_without_allocating() {
    assert_eq!(checked_environment_block_length(1, 3, 4).unwrap(), 10);
    assert!(checked_environment_block_length(usize::MAX, 0, 0).is_err());
    assert!(checked_environment_block_length(1, usize::MAX, 0).is_err());
    assert!(checked_environment_block_length(1, 0, usize::MAX).is_err());
}

#[test]
fn environment_key_length_checks_compare_api_boundary_without_allocating() {
    assert_eq!(
        checked_environment_key_length(i32::MAX as usize).unwrap(),
        i32::MAX
    );
    assert!(checked_environment_key_length(i32::MAX as usize + 1).is_err());
}

#[test]
fn environment_block_rejects_unicode_case_insensitive_duplicates() {
    for environment in [
        [
            (OsString::from("PATH"), OsString::from("one")),
            (OsString::from("path"), OsString::from("two")),
        ],
        [
            (OsString::from("Å"), OsString::from("one")),
            (OsString::from("å"), OsString::from("two")),
        ],
    ] {
        assert!(environment_block(&environment).is_err());
    }
}

#[test]
fn environment_block_sorts_with_unicode_ordinal_ignore_case_semantics() {
    let entries = [
        (OsString::from("ä"), OsString::from("3")),
        (OsString::from("b"), OsString::from("2")),
        (OsString::from("A"), OsString::from("1")),
    ];
    let first = environment_block(&entries).unwrap();
    let second =
        environment_block(&[entries[1].clone(), entries[0].clone(), entries[2].clone()]).unwrap();

    assert!(first == second);
    let entries = environment_entries(&first);
    let keys: Vec<&str> = entries
        .iter()
        .map(|entry| entry.split_once('=').unwrap().0)
        .collect();
    for pair in keys.windows(2) {
        let left: Vec<u16> = OsStr::new(pair[0]).encode_wide().collect();
        let right: Vec<u16> = OsStr::new(pair[1]).encode_wide().collect();
        assert_eq!(
            compare_environment_keys(&left, &right).unwrap(),
            std::cmp::Ordering::Less
        );
    }
}

#[test]
fn empty_environment_does_not_inherit_host_environment() {
    if std::env::current_dir()
        .unwrap()
        .ends_with(EMPTY_CHILD_MARKER)
    {
        assert!(std::env::vars_os().next().is_none());
        return;
    }

    match std::env::var_os(HOST_ROLE).as_deref() {
        Some(role) if role == OsStr::new("empty-host") => {
            assert!(std::env::var_os(HOST_ONLY_KEY).as_deref() == Some(OsStr::new("host-only")));
            let directory = TestDirectory::new("windows-empty-environment");
            let child_directory = directory.path().join(EMPTY_CHILD_MARKER);
            std::fs::create_dir(&child_directory).unwrap();
            let spec = LaunchSpec::try_new(
                std::env::current_exe().unwrap(),
                child_directory,
                [
                    OsString::from(EMPTY_ENVIRONMENT_TEST),
                    OsString::from("--exact"),
                    OsString::from("--test-threads=1"),
                ],
                [],
                StdioSpec::new(StdioMode::Null, StdioMode::Null, StdioMode::Null),
            )
            .unwrap();
            let mut authority = custody::launch(&spec).unwrap();
            assert_eq!(wait_for_exit(&mut authority).exit_code(), Some(0));
        }
        Some(_) => panic!("unexpected empty-environment helper role"),
        None => {
            let status = Command::new(std::env::current_exe().unwrap())
                .args([EMPTY_ENVIRONMENT_TEST, "--exact", "--test-threads=1"])
                .env(HOST_ROLE, "empty-host")
                .env(HOST_ONLY_KEY, "host-only")
                .status()
                .unwrap();
            assert!(status.success(), "host helper failed");
        }
    }
}

#[test]
fn exact_environment_does_not_inherit_host_environment() {
    match std::env::var_os(HOST_ROLE).as_deref() {
        Some(role) if role == OsStr::new("host") => run_exact_environment_host(),
        Some(role) if role == OsStr::new("child") => run_exact_environment_child(),
        Some(_) => panic!("unexpected exact-environment helper role"),
        None => {
            let status = Command::new(std::env::current_exe().unwrap())
                .args([EXACT_ENVIRONMENT_TEST, "--exact", "--test-threads=1"])
                .env(HOST_ROLE, "host")
                .env(HOST_ONLY_KEY, "host-only")
                .status()
                .unwrap();
            assert!(status.success(), "host helper failed");
        }
    }
}

fn run_exact_environment_host() {
    assert!(std::env::var_os(HOST_ONLY_KEY).as_deref() == Some(OsStr::new("host-only")));
    let spec = LaunchSpec::try_new(
        std::env::current_exe().unwrap(),
        std::env::current_dir().unwrap(),
        [
            OsString::from(EXACT_ENVIRONMENT_TEST),
            OsString::from("--exact"),
            OsString::from("--test-threads=1"),
        ],
        [
            (OsString::from(HOST_ROLE), OsString::from("child")),
            (OsString::from(UNICODE_KEY), OsString::from(UNICODE_VALUE)),
        ],
        StdioSpec::new(StdioMode::Null, StdioMode::Null, StdioMode::Null),
    )
    .unwrap();
    let mut authority = custody::launch(&spec).unwrap();
    assert_eq!(wait_for_exit(&mut authority).exit_code(), Some(0));
}

fn run_exact_environment_child() {
    let environment = std::env::vars_os().collect::<Vec<_>>();
    assert_eq!(environment.len(), 2);
    assert!(environment.iter().any(|(key, _)| key == HOST_ROLE));
    assert!(environment.iter().any(|(key, _)| key == UNICODE_KEY));
    assert!(std::env::var_os(HOST_ROLE).as_deref() == Some(OsStr::new("child")));
    assert!(std::env::var_os(UNICODE_KEY).as_deref() == Some(OsStr::new(UNICODE_VALUE)));
    assert!(std::env::var_os(HOST_ONLY_KEY).is_none());
}

fn wait_for_exit(
    authority: &mut custody::WindowsAuthorityScope,
) -> crate::process::ExitObservation {
    let deadline = Instant::now() + Duration::from_secs(10);
    loop {
        if let Some(observation) = authority.probe_exit().unwrap() {
            return observation;
        }
        assert!(Instant::now() < deadline, "child did not exit");
        thread::sleep(Duration::from_millis(10));
    }
}

#[test]
fn environment_errors_never_include_keys_or_values() {
    let private_key = "MATCHA_PRIVATE_KEY_MATERIAL";
    let private_value = "private-test-material";
    let error = environment_block(&[
        (OsString::from(private_key), OsString::from(private_value)),
        (OsString::from(private_key), OsString::from("other")),
    ])
    .unwrap_err()
    .to_string();

    assert!(!error.contains(private_key));
    assert!(!error.contains(private_value));
}
