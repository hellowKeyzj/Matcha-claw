pub fn contains_private_fragment(value: &str) -> bool {
    let normalized = normalize_public_text(value);
    let trimmed = normalized.trim();
    compound_private_marker(trimmed) || trimmed.split_whitespace().any(private_segment)
}

pub fn sensitive_key(key: &str) -> bool {
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
