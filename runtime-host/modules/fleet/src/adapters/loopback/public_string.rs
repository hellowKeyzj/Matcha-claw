#![allow(dead_code)]

use std::collections::BTreeMap;

const MAX_PUBLIC_TEXT_CHARS: usize = 512;
const REDACTED: &str = "[redacted]";

pub(crate) fn public_text(value: &str) -> Option<String> {
    let normalized = normalize_public_text(value);
    let trimmed = normalized.trim();
    if trimmed.is_empty() {
        return None;
    }
    Some(truncate_public_text(&redact_private_fragments(trimmed)))
}

pub(crate) fn public_error(value: &str, fallback: &str) -> String {
    public_text(value)
        .filter(|value| value != REDACTED)
        .unwrap_or_else(|| fallback.to_owned())
}

pub(crate) fn public_details(
    values: &BTreeMap<String, String>,
) -> Option<BTreeMap<String, String>> {
    let details = values
        .iter()
        .filter(|(key, _)| public_detail_key(key))
        .filter_map(|(key, value)| public_text(value).map(|value| (key.clone(), value)))
        .collect::<BTreeMap<_, _>>();
    (!details.is_empty()).then_some(details)
}

pub(crate) fn contains_private_fragment(value: &str) -> bool {
    let normalized = normalize_public_text(value);
    let trimmed = normalized.trim();
    compound_private_marker(trimmed) || trimmed.split_whitespace().any(private_segment)
}

pub(crate) fn sensitive_key(key: &str) -> bool {
    let normalized: String = key
        .chars()
        .filter(|character| character.is_ascii_alphanumeric())
        .flat_map(char::to_lowercase)
        .collect();
    [
        "token",
        "secret",
        "password",
        "credential",
        "authorization",
        "accesskey",
        "privatekey",
        "apikey",
        "stderr",
        "stdout",
        "stacktrace",
        "error",
        "path",
        "filepath",
        "localpath",
        "nativepath",
        "privatepath",
        "workspacepath",
        "logfile",
        "output",
    ]
    .iter()
    .any(|marker| normalized.contains(marker))
}

fn normalize_public_text(value: &str) -> String {
    value
        .chars()
        .map(|character| {
            if character.is_control() {
                ' '
            } else {
                character
            }
        })
        .collect()
}

fn redact_private_fragments(value: &str) -> String {
    if compound_private_marker(value) {
        return REDACTED.to_owned();
    }
    let mut output = String::new();
    for segment in value.split_whitespace() {
        if !output.is_empty() {
            output.push(' ');
        }
        if private_segment(segment) {
            output.push_str(REDACTED);
        } else {
            output.push_str(segment);
        }
    }
    output
}

fn truncate_public_text(value: &str) -> String {
    let mut characters = value.chars();
    let mut output = characters
        .by_ref()
        .take(MAX_PUBLIC_TEXT_CHARS)
        .collect::<String>();
    if characters.next().is_some() {
        output.push_str("...");
    }
    output
}

fn compound_private_marker(value: &str) -> bool {
    let normalized = value.to_ascii_lowercase().replace('\\', "/");
    normalized.contains("authorization:")
        || normalized.contains("bearer ")
        || normalized.contains("-----begin ")
        || normalized.contains("access_token")
        || normalized.contains("refresh_token")
        || normalized.contains("/appdata/")
}

fn private_segment(segment: &str) -> bool {
    let value = segment.trim_matches(|character: char| {
        matches!(
            character,
            '"' | '\'' | '`' | ',' | ';' | '(' | ')' | '[' | ']' | '{' | '}'
        )
    });
    let normalized = value.to_ascii_lowercase().replace('\\', "/");
    sensitive_assignment(&normalized)
        || native_path_segment(&normalized)
        || normalized.starts_with("stdout=")
        || normalized.starts_with("stdout:")
        || normalized.starts_with("stderr=")
        || normalized.starts_with("stderr:")
}

fn sensitive_assignment(value: &str) -> bool {
    [
        "token=",
        "token:",
        "secret=",
        "secret:",
        "password=",
        "password:",
        "credential=",
        "credential:",
        "authorization=",
        "apikey=",
        "api_key=",
        "accesskey=",
        "access_key=",
        "privatekey=",
        "private_key=",
    ]
    .iter()
    .any(|marker| value.starts_with(marker) || value.contains(marker))
}

fn native_path_segment(value: &str) -> bool {
    let bytes = value.as_bytes();
    (bytes.len() >= 3 && bytes[0].is_ascii_alphabetic() && bytes[1] == b':' && bytes[2] == b'/')
        || value.starts_with("//")
        || value.starts_with("/users/")
        || value.starts_with("/home/")
        || value.starts_with("/var/")
        || value.starts_with("/tmp/")
        || value.starts_with("/workspace/")
        || value.contains("/.ssh/")
}

fn public_detail_key(key: &str) -> bool {
    !key.is_empty()
        && key.chars().count() <= 128
        && !key.contains('/')
        && !key.contains('\\')
        && !sensitive_key(key)
        && key
            .chars()
            .all(|character| !character.is_control() && !character.is_whitespace())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn public_text_preserves_legal_labels_and_redacts_private_fragments() {
        assert_eq!(
            public_text("Bot token required").as_deref(),
            Some("Bot token required")
        );
        assert_eq!(
            public_text("failed at C:\\Users\\me\\secret.txt token=abc").as_deref(),
            Some("failed at [redacted] [redacted]")
        );
        assert_eq!(
            public_text("Authorization: Bearer abc").as_deref(),
            Some("[redacted]")
        );
    }

    #[test]
    fn public_details_drops_private_keys_and_sanitizes_values() {
        let details = public_details(&BTreeMap::from([
            ("status".into(), "missing field".into()),
            ("stderr".into(), "raw stderr".into()),
            ("path".into(), "C:\\Users\\me\\secret.txt".into()),
            ("hint".into(), "see /home/me/.ssh/id_rsa".into()),
        ]))
        .unwrap();
        assert_eq!(
            details.get("status").map(String::as_str),
            Some("missing field")
        );
        assert_eq!(
            details.get("hint").map(String::as_str),
            Some("see [redacted]")
        );
        assert!(!details.contains_key("stderr"));
        assert!(!details.contains_key("path"));
    }
}
