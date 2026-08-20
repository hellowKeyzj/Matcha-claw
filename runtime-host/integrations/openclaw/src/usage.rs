use std::{
    fs,
    io::{BufRead, BufReader},
    path::{Path, PathBuf},
    time::SystemTime,
};

use serde_json::Value;

const DEFAULT_LIMIT: usize = 100;
const MAX_LIMIT: usize = 1_000;
const MAX_SAFE_INTEGER: u64 = 9_007_199_254_740_991;

#[derive(Clone, Debug, PartialEq)]
pub struct UsageEntry {
    agent_id: String,
    session_id: String,
    timestamp: String,
    instant_nanos: i128,
    model: Option<String>,
    provider: Option<String>,
    input_tokens: u64,
    output_tokens: u64,
    cache_read_tokens: u64,
    cache_write_tokens: u64,
    total_tokens: u64,
    cost_usd: Option<f64>,
}

impl UsageEntry {
    pub fn agent_id(&self) -> &str {
        &self.agent_id
    }

    pub fn session_id(&self) -> &str {
        &self.session_id
    }

    pub fn timestamp(&self) -> &str {
        &self.timestamp
    }

    pub fn model(&self) -> Option<&str> {
        self.model.as_deref()
    }

    pub fn provider(&self) -> Option<&str> {
        self.provider.as_deref()
    }

    pub const fn input_tokens(&self) -> u64 {
        self.input_tokens
    }

    pub const fn output_tokens(&self) -> u64 {
        self.output_tokens
    }

    pub const fn cache_read_tokens(&self) -> u64 {
        self.cache_read_tokens
    }

    pub const fn cache_write_tokens(&self) -> u64 {
        self.cache_write_tokens
    }

    pub const fn total_tokens(&self) -> u64 {
        self.total_tokens
    }

    pub const fn cost_usd(&self) -> Option<f64> {
        self.cost_usd
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum UsageHistoryError {
    Unavailable,
}

pub struct UsageHistory {
    root: PathBuf,
}

impl UsageHistory {
    pub fn new(root: impl Into<PathBuf>) -> Self {
        Self { root: root.into() }
    }

    pub fn recent(&self, limit: usize) -> Result<Vec<UsageEntry>, UsageHistoryError> {
        let limit = limit.clamp(1, MAX_LIMIT);
        let mut files = session_files(&self.root)?;
        files.sort_by_key(|file| std::cmp::Reverse(file.modified));

        let mut entries = Vec::with_capacity(limit);
        for file in files {
            read_usage_entries(&file, &mut entries, limit);
        }
        entries.sort_by_key(|entry| std::cmp::Reverse(entry.instant_nanos));
        Ok(entries)
    }

    pub const fn default_limit() -> usize {
        DEFAULT_LIMIT
    }

    pub const fn max_limit() -> usize {
        MAX_LIMIT
    }
}

struct SessionFile {
    path: PathBuf,
    modified: SystemTime,
    agent_id: String,
    session_id: String,
}

fn session_files(root: &Path) -> Result<Vec<SessionFile>, UsageHistoryError> {
    let agents = root.join("agents");
    let agent_entries = match fs::read_dir(agents) {
        Ok(entries) => entries,
        Err(_) => return Ok(Vec::new()),
    };
    let mut files = Vec::new();
    for agent in agent_entries.flatten() {
        if !agent.file_type().is_ok_and(|kind| kind.is_dir()) {
            continue;
        }
        let agent_name = agent.file_name();
        let Some(agent_id) = safe_agent_id(agent_name.to_str()) else {
            continue;
        };
        let sessions_dir = agent.path().join("sessions");
        let session_store = load_session_store(&sessions_dir);
        let sessions = match fs::read_dir(&sessions_dir) {
            Ok(entries) => entries,
            Err(_) => continue,
        };
        for entry in sessions.flatten() {
            if !entry.file_type().is_ok_and(|kind| kind.is_file())
                || !is_live_or_reset_transcript(&entry.file_name())
            {
                continue;
            }
            let Some(session_id) = session_id_for_file(
                &sessions_dir,
                &entry.path(),
                &entry.file_name(),
                &session_store,
            ) else {
                continue;
            };
            let Ok(metadata) = entry.metadata() else {
                continue;
            };
            files.push(SessionFile {
                path: entry.path(),
                modified: metadata.modified().unwrap_or(SystemTime::UNIX_EPOCH),
                agent_id: agent_id.to_owned(),
                session_id,
            });
        }
    }
    Ok(files)
}

struct SessionStoreEntry {
    session_id: Option<String>,
    session_file: String,
}

fn load_session_store(sessions_dir: &Path) -> Vec<SessionStoreEntry> {
    let Ok(bytes) = fs::read(sessions_dir.join("sessions.json")) else {
        return Vec::new();
    };
    let Ok(Value::Object(store)) = serde_json::from_slice::<Value>(&bytes) else {
        return Vec::new();
    };
    store
        .into_values()
        .filter_map(|value| {
            let Value::Object(entry) = value else {
                return None;
            };
            let session_file = entry
                .get("sessionFile")
                .and_then(Value::as_str)
                .map(str::trim)
                .filter(|value| !value.is_empty() && value.len() <= 4_096)
                .map(str::to_owned)?;
            Some(SessionStoreEntry {
                session_id: safe_session_id(entry.get("sessionId").and_then(Value::as_str))
                    .map(str::to_owned),
                session_file,
            })
        })
        .collect()
}

fn session_id_for_file(
    sessions_dir: &Path,
    file_path: &Path,
    file_name: &std::ffi::OsStr,
    store: &[SessionStoreEntry],
) -> Option<String> {
    let mut matched_session_id = None;
    let mut matched_store_file = false;
    for entry in store {
        if session_file_matches(sessions_dir, file_path, file_name, &entry.session_file) {
            matched_store_file = true;
            let Some(session_id) = entry.session_id.as_deref() else {
                return None;
            };
            if matched_session_id.is_some_and(|existing| existing != session_id) {
                return None;
            }
            matched_session_id = Some(session_id);
        }
    }
    if matched_store_file {
        return matched_session_id.map(str::to_owned);
    }
    let name = file_name.to_str()?;
    let session_id = if is_primary_transcript(name) {
        name.strip_suffix(".jsonl")?
    } else {
        let marker = ".jsonl.reset.";
        name.rfind(marker).map(|index| &name[..index])?
    };
    safe_session_id(Some(session_id)).map(str::to_owned)
}

fn session_file_matches(
    sessions_dir: &Path,
    file_path: &Path,
    file_name: &std::ffi::OsStr,
    session_file: &str,
) -> bool {
    let Ok(base) = fs::canonicalize(sessions_dir) else {
        return false;
    };
    let candidate = Path::new(session_file);
    let candidate = if candidate.is_absolute() {
        candidate.to_owned()
    } else {
        sessions_dir.join(candidate)
    };
    let Some(candidate_name) = candidate.file_name() else {
        return false;
    };
    let Some(candidate_parent) = candidate.parent() else {
        return false;
    };
    let Ok(candidate_parent) = fs::canonicalize(candidate_parent) else {
        return false;
    };
    if !candidate_parent.starts_with(&base) {
        return false;
    }
    let candidate = candidate_parent.join(candidate_name);
    let Ok(file_path) = fs::canonicalize(file_path) else {
        return false;
    };
    if candidate == file_path {
        return true;
    }
    if candidate.parent() != file_path.parent() {
        return false;
    }
    let Some(file_name) = file_name.to_str() else {
        return false;
    };
    let Some(candidate_name) = candidate_name.to_str() else {
        return false;
    };
    file_name.starts_with(candidate_name)
        && file_name
            .strip_prefix(candidate_name)
            .is_some_and(|suffix| is_archive(suffix, "reset"))
}

fn safe_agent_id(value: Option<&str>) -> Option<&str> {
    let value = value?;
    let bytes = value.as_bytes();
    if bytes.is_empty() || bytes.len() > 64 || !bytes[0].is_ascii_alphanumeric() {
        return None;
    }
    if !bytes
        .iter()
        .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'_' | b'-'))
    {
        return None;
    }
    value
        .bytes()
        .all(|byte| !byte.is_ascii_uppercase())
        .then_some(value)
}

fn safe_session_id(value: Option<&str>) -> Option<&str> {
    let value = value?;
    let bytes = value.as_bytes();
    if bytes.is_empty() || bytes.len() > 128 || !bytes[0].is_ascii_alphanumeric() {
        return None;
    }
    if !bytes
        .iter()
        .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'_' | b'-'))
    {
        return None;
    }
    let checkpoint_name = format!("{value}.jsonl");
    (!is_compaction_checkpoint(&checkpoint_name)).then_some(value)
}

fn is_live_or_reset_transcript(name: &std::ffi::OsStr) -> bool {
    let Some(name) = name.to_str() else {
        return false;
    };
    is_primary_transcript(name) || is_reset_archive(name)
}

fn is_primary_transcript(name: &str) -> bool {
    name.ends_with(".jsonl")
        && name != "sessions.json"
        && !name.ends_with(".trajectory.jsonl")
        && !name.contains(".deleted.")
        && !name.contains(".deleted.jsonl")
        && !is_archive(name, "deleted")
        && !is_archive(name, "reset")
        && !is_archive(name, "bak")
        && !is_compaction_checkpoint(name)
}

fn is_reset_archive(name: &str) -> bool {
    is_archive(name, "reset")
}

fn is_archive(name: &str, reason: &str) -> bool {
    let marker = format!(".{reason}.");
    let Some(index) = name.rfind(&marker) else {
        return false;
    };
    is_archive_timestamp(&name[index + marker.len()..])
}

fn is_archive_timestamp(value: &str) -> bool {
    let bytes = value.as_bytes();
    if !matches!(bytes.len(), 20 | 24) {
        return false;
    }
    let separators = [(4, b'-'), (7, b'-'), (10, b'T'), (13, b'-'), (16, b'-')];
    let valid_prefix = separators
        .iter()
        .all(|(index, expected)| bytes[*index] == *expected)
        && bytes[..19].iter().enumerate().all(|(index, byte)| {
            separators.iter().any(|(separator, _)| *separator == index) || byte.is_ascii_digit()
        });

    match bytes.len() {
        20 => valid_prefix && bytes[19] == b'Z',
        24 => {
            valid_prefix
                && bytes[19] == b'.'
                && bytes[20..23].iter().all(u8::is_ascii_digit)
                && bytes[23] == b'Z'
        }
        _ => false,
    }
}

fn is_compaction_checkpoint(name: &str) -> bool {
    let Some(prefix) = name.strip_suffix(".jsonl") else {
        return false;
    };
    let Some((_, checkpoint)) = prefix.rsplit_once(".checkpoint.") else {
        return false;
    };
    is_uuid_v1_to_v5(checkpoint)
}

fn is_uuid_v1_to_v5(value: &str) -> bool {
    let bytes = value.as_bytes();
    bytes.len() == 36
        && [8, 13, 18, 23]
            .into_iter()
            .all(|index| bytes.get(index) == Some(&b'-'))
        && bytes
            .iter()
            .enumerate()
            .all(|(index, byte)| matches!(index, 8 | 13 | 18 | 23) || byte.is_ascii_hexdigit())
        && matches!(bytes[14], b'1'..=b'5')
        && matches!(bytes[19], b'8' | b'9' | b'a' | b'b' | b'A' | b'B')
}

fn read_usage_entries(file: &SessionFile, entries: &mut Vec<UsageEntry>, limit: usize) {
    let Ok(file_handle) = fs::File::open(&file.path) else {
        return;
    };
    for line in BufReader::new(file_handle).lines().map_while(Result::ok) {
        let Ok(value) = serde_json::from_str::<Value>(&line) else {
            continue;
        };
        let Some(entry) = parse_entry(&value, &file.agent_id, &file.session_id) else {
            continue;
        };
        insert_newest(entries, entry, limit);
    }
}

fn insert_newest(entries: &mut Vec<UsageEntry>, entry: UsageEntry, limit: usize) {
    let position = entries
        .iter()
        .position(|existing| entry.instant_nanos > existing.instant_nanos)
        .unwrap_or(entries.len());
    if position == entries.len() && entries.len() == limit {
        return;
    }
    entries.insert(position, entry);
    if entries.len() > limit {
        entries.pop();
    }
}

fn parse_entry(value: &Value, agent_id: &str, session_id: &str) -> Option<UsageEntry> {
    let record = value.as_object()?;
    let timestamp = non_empty_string(record.get("timestamp"))?;
    let instant_nanos = parse_rfc3339_instant_nanos(&timestamp)?;
    let message = record.get("message")?.as_object()?;
    let role = message
        .get("role")
        .and_then(Value::as_str)?
        .to_ascii_lowercase();
    let (usage, model, provider) = if role == "assistant" && message.contains_key("usage") {
        (
            message.get("usage")?,
            optional_string(message.get("model"))
                .or_else(|| optional_string(message.get("modelRef"))),
            optional_string(message.get("provider")),
        )
    } else if role == "toolresult" || role == "tool_result" {
        let details = message.get("details")?.as_object()?;
        (
            details.get("usage")?,
            optional_string(details.get("model"))
                .or_else(|| optional_string(message.get("model")))
                .or_else(|| optional_string(message.get("modelRef"))),
            optional_string(details.get("provider"))
                .or_else(|| {
                    details
                        .get("externalContent")
                        .and_then(Value::as_object)
                        .and_then(|value| optional_string(value.get("provider")))
                })
                .or_else(|| optional_string(message.get("provider"))),
        )
    } else {
        return None;
    };
    let usage = usage.as_object()?;
    let input_tokens = first_u64(
        usage,
        &[
            "input",
            "promptTokens",
            "prompt_tokens",
            "input_tokens",
            "inputTokenCount",
            "input_token_count",
            "promptTokenCount",
            "prompt_token_count",
        ],
    );
    let output_tokens = first_u64(
        usage,
        &[
            "output",
            "completionTokens",
            "completion_tokens",
            "output_tokens",
            "outputTokenCount",
            "output_token_count",
            "completionTokenCount",
            "completion_token_count",
        ],
    );
    let cache_read_tokens = first_u64(
        usage,
        &[
            "cacheRead",
            "cache_read",
            "cacheReadTokens",
            "cache_read_tokens",
            "cacheReadTokenCount",
            "cache_read_token_count",
        ],
    );
    let cache_write_tokens = first_u64(
        usage,
        &[
            "cacheWrite",
            "cache_write",
            "cacheWriteTokens",
            "cache_write_tokens",
            "cacheWriteTokenCount",
            "cache_write_token_count",
        ],
    );
    let explicit_total = first_u64(
        usage,
        &[
            "total",
            "totalTokens",
            "total_tokens",
            "totalTokenCount",
            "total_token_count",
        ],
    );
    let cost_usd = usage
        .get("cost")
        .and_then(Value::as_object)
        .and_then(|cost| non_negative_f64(cost.get("total")));
    if input_tokens.is_none()
        && output_tokens.is_none()
        && cache_read_tokens.is_none()
        && cache_write_tokens.is_none()
        && explicit_total.is_none()
        && cost_usd.is_none()
    {
        return None;
    }
    let input_tokens = input_tokens.unwrap_or_default();
    let output_tokens = output_tokens.unwrap_or_default();
    let cache_read_tokens = cache_read_tokens.unwrap_or_default();
    let cache_write_tokens = cache_write_tokens.unwrap_or_default();
    let computed_total = input_tokens
        .checked_add(output_tokens)?
        .checked_add(cache_read_tokens)?
        .checked_add(cache_write_tokens)?;
    let total_tokens = explicit_total.unwrap_or(computed_total);
    (total_tokens <= MAX_SAFE_INTEGER).then_some(UsageEntry {
        agent_id: agent_id.to_owned(),
        session_id: session_id.to_owned(),
        timestamp,
        instant_nanos,
        model,
        provider,
        input_tokens,
        output_tokens,
        cache_read_tokens,
        cache_write_tokens,
        total_tokens,
        cost_usd,
    })
}

fn parse_rfc3339_instant_nanos(value: &str) -> Option<i128> {
    let bytes = value.as_bytes();
    if bytes.len() < 20
        || bytes.get(4) != Some(&b'-')
        || bytes.get(7) != Some(&b'-')
        || bytes.get(10) != Some(&b'T')
        || bytes.get(13) != Some(&b':')
        || bytes.get(16) != Some(&b':')
    {
        return None;
    }
    let year = decimal(bytes, 0, 4)?;
    let month = decimal(bytes, 5, 2)?;
    let day = decimal(bytes, 8, 2)?;
    let hour = decimal(bytes, 11, 2)?;
    let minute = decimal(bytes, 14, 2)?;
    let second = decimal(bytes, 17, 2)?;
    if !(1..=12).contains(&month)
        || !(1..=days_in_month(year, month)).contains(&day)
        || hour > 23
        || minute > 59
        || second > 59
    {
        return None;
    }

    let mut index = 19;
    let mut nanos = 0_i128;
    if bytes.get(index) == Some(&b'.') {
        index += 1;
        let fraction_start = index;
        while bytes.get(index).is_some_and(u8::is_ascii_digit) {
            if index - fraction_start < 9 {
                nanos = nanos * 10 + i128::from(bytes[index] - b'0');
            }
            index += 1;
        }
        let fraction_len = index - fraction_start;
        if fraction_len == 0 {
            return None;
        }
        for _ in fraction_len.min(9)..9 {
            nanos *= 10;
        }
    }

    let offset_seconds = match bytes.get(index) {
        Some(b'Z') if index + 1 == bytes.len() => 0,
        Some(sign @ (b'+' | b'-'))
            if index + 6 == bytes.len() && bytes.get(index + 3) == Some(&b':') =>
        {
            let offset_hours = decimal(bytes, index + 1, 2)?;
            let offset_minutes = decimal(bytes, index + 4, 2)?;
            if offset_hours > 23 || offset_minutes > 59 {
                return None;
            }
            let offset = offset_hours * 3_600 + offset_minutes * 60;
            if *sign == b'+' { offset } else { -offset }
        }
        _ => return None,
    };

    i128::from(days_from_civil(year, month, day))
        .checked_mul(86_400)?
        .checked_add(i128::from(hour * 3_600 + minute * 60 + second))?
        .checked_sub(i128::from(offset_seconds))?
        .checked_mul(1_000_000_000)?
        .checked_add(nanos)
}

fn decimal(bytes: &[u8], start: usize, length: usize) -> Option<i64> {
    bytes
        .get(start..start.checked_add(length)?)?
        .iter()
        .try_fold(0_i64, |value, digit| {
            digit
                .is_ascii_digit()
                .then(|| value * 10 + i64::from(*digit - b'0'))
        })
}

const fn days_in_month(year: i64, month: i64) -> i64 {
    match month {
        1 | 3 | 5 | 7 | 8 | 10 | 12 => 31,
        4 | 6 | 9 | 11 => 30,
        2 if year % 4 == 0 && (year % 100 != 0 || year % 400 == 0) => 29,
        2 => 28,
        _ => 0,
    }
}

const fn days_from_civil(year: i64, month: i64, day: i64) -> i64 {
    let year = if month <= 2 { year - 1 } else { year };
    let era = year / 400;
    let year_of_era = year - era * 400;
    let month_from_march = month + if month > 2 { -3 } else { 9 };
    let day_of_year = (153 * month_from_march + 2) / 5 + day - 1;
    era * 146_097 + year_of_era * 365 + year_of_era / 4 - year_of_era / 100 + day_of_year - 719_468
}

fn first_u64(record: &serde_json::Map<String, Value>, keys: &[&str]) -> Option<u64> {
    keys.iter()
        .find_map(|key| non_negative_u64(record.get(*key)))
}

fn non_negative_u64(value: Option<&Value>) -> Option<u64> {
    let value = match value? {
        Value::Number(value) => value.as_u64()?,
        Value::String(value) => value.trim().parse().ok()?,
        _ => return None,
    };
    (value <= MAX_SAFE_INTEGER).then_some(value)
}

fn non_negative_f64(value: Option<&Value>) -> Option<f64> {
    let value = match value? {
        Value::Number(value) => value.as_f64()?,
        Value::String(value) => value.trim().parse().ok()?,
        _ => return None,
    };
    (value.is_finite() && value >= 0.0).then_some(value)
}

fn optional_string(value: Option<&Value>) -> Option<String> {
    let value = value?.as_str()?.trim();
    (!value.is_empty() && value.len() <= 256).then(|| value.to_owned())
}

fn non_empty_string(value: Option<&Value>) -> Option<String> {
    optional_string(value)
}

#[cfg(test)]
mod tests {
    use std::{
        fs,
        sync::atomic::{AtomicU64, Ordering},
    };

    use super::*;

    struct TestRoot(PathBuf);

    impl TestRoot {
        fn new() -> Self {
            static NEXT: AtomicU64 = AtomicU64::new(0);
            let path = std::env::temp_dir().join(format!(
                "openclaw-usage-test-{}",
                NEXT.fetch_add(1, Ordering::Relaxed)
            ));
            fs::create_dir_all(&path).unwrap();
            Self(path)
        }

        fn session(&self, agent: &str, file: &str, content: &str) {
            let directory = self.0.join("agents").join(agent).join("sessions");
            fs::create_dir_all(&directory).unwrap();
            fs::write(directory.join(file), content).unwrap();
        }

        fn session_store(&self, agent: &str, content: &str) {
            let directory = self.0.join("agents").join(agent).join("sessions");
            fs::create_dir_all(&directory).unwrap();
            fs::write(directory.join("sessions.json"), content).unwrap();
        }
    }

    impl Drop for TestRoot {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    #[test]
    fn reads_safe_aliases_newest_first_excludes_deleted_and_includes_reset() {
        let root = TestRoot::new();
        root.session("main", "live.jsonl", concat!(
            "{bad json}\n",
            r#"{"timestamp":"2026-04-01T00:00:00.000Z","message":{"role":"assistant","model":"m1","provider":"p1","usage":{"input_token_count":"11","output_tokens":5,"total":16}}}"#, "\n",
            r#"{"timestamp":"2026-04-02T00:00:00.000Z","message":{"role":"tool_result","details":{"model":"m2","usage":{"input":2,"output":3}}}}"#, "\n"
        ));
        root.session("main", "old.jsonl.deleted.2026-04-01T00-00-00Z", r#"{"timestamp":"2099-01-01T00:00:00.000Z","message":{"role":"assistant","usage":{"total":99}}}"#);
        root.session("main", "old.jsonl.reset.2026-04-01T00-00-00Z", r#"{"timestamp":"2026-04-03T00:00:00.000Z","message":{"role":"assistant","usage":{"total_tokens":7}}}"#);

        let entries = UsageHistory::new(&root.0).recent(2).unwrap();
        assert_eq!(entries.len(), 2);
        assert_eq!(entries[0].agent_id(), "main");
        assert_eq!(entries[0].session_id(), "old");
        assert_eq!(entries[1].agent_id(), "main");
        assert_eq!(entries[1].session_id(), "live");
        assert_eq!(entries[0].timestamp(), "2026-04-03T00:00:00.000Z");
        assert_eq!(entries[1].timestamp(), "2026-04-02T00:00:00.000Z");
        assert_eq!(entries[0].total_tokens(), 7);
        assert_eq!(entries[1].total_tokens(), 5);
        assert_eq!(entries[1].model(), Some("m2"));
    }

    #[test]
    fn resolves_custom_session_file_from_authoritative_store_identity() {
        let root = TestRoot::new();
        root.session_store(
            "main",
            r#"{"agent:main:topic":{"sessionId":"authoritative-id","sessionFile":"custom-topic.jsonl"}}"#,
        );
        root.session(
            "main",
            "custom-topic.jsonl",
            r#"{"timestamp":"2026-04-01T00:00:00.000Z","message":{"role":"assistant","usage":{"total":1}}}"#,
        );
        root.session(
            "main",
            "custom-topic.jsonl.reset.2026-04-02T00-00-00Z",
            r#"{"timestamp":"2026-04-02T00:00:00.000Z","message":{"role":"assistant","usage":{"total":2}}}"#,
        );

        let entries = UsageHistory::new(&root.0).recent(1).unwrap();
        assert_eq!(entries.len(), 1);
        assert_eq!(entries[0].agent_id(), "main");
        assert_eq!(entries[0].session_id(), "authoritative-id");
        assert_eq!(entries[0].total_tokens(), 2);
    }

    #[test]
    fn skips_transcripts_without_a_safe_session_identity() {
        let root = TestRoot::new();
        root.session_store(
            "main",
            r#"{"agent:main:invalid":{"sessionId":"../unsafe","sessionFile":"bad space.jsonl"}}"#,
        );
        root.session(
            "main",
            "bad space.jsonl",
            r#"{"timestamp":"2026-04-01T00:00:00.000Z","message":{"role":"assistant","usage":{"total":1}}}"#,
        );
        root.session(
            "main",
            "-unsafe.jsonl",
            r#"{"timestamp":"2026-04-01T00:00:00.000Z","message":{"role":"assistant","usage":{"total":1}}}"#,
        );
        assert!(UsageHistory::new(&root.0).recent(1).unwrap().is_empty());
    }

    #[test]
    fn accepts_only_openclaw_live_and_reset_filename_grammar() {
        for name in [
            "live.jsonl",
            "custom-topic.jsonl",
            "session.jsonl.reset.2026-04-01T00-00-00Z",
            "session.jsonl.reset.2026-04-01T00-00-00.123Z",
        ] {
            assert!(
                is_live_or_reset_transcript(std::ffi::OsStr::new(name)),
                "{name}"
            );
        }
        for name in [
            "sessions.json",
            "live.trajectory.jsonl",
            "session.checkpoint.123e4567-e89b-42d3-a456-426614174000.jsonl",
            "session.jsonl.deleted.2026-04-01T00-00-00Z",
            "session.deleted.jsonl",
            "session.jsonl.bak.2026-04-01T00-00-00Z",
            "session.jsonl.reset.not-a-timestamp",
            "session.jsonl.reset.2026-04-01T00-00-00Z.tmp",
        ] {
            assert!(
                !is_live_or_reset_transcript(std::ffi::OsStr::new(name)),
                "{name}"
            );
        }
    }

    #[test]
    fn preserves_explicit_total_and_bounds_the_newest_projection() {
        let root = TestRoot::new();
        root.session("main", "live.jsonl", concat!(
            r#"{"timestamp":"2026-04-01T00:00:00.000Z","message":{"role":"assistant","usage":{"input":2,"output":3,"cacheRead":5,"total":99}}}"#, "\n",
            r#"{"timestamp":"2026-04-02T00:00:00.000Z","message":{"role":"assistant","usage":{"total":2}}}"#, "\n",
            r#"{"timestamp":"2026-04-03T00:00:00.000Z","message":{"role":"assistant","usage":{"total":3}}}"#
        ));

        let entries = UsageHistory::new(&root.0).recent(2).unwrap();
        assert_eq!(entries.len(), 2);
        assert_eq!(entries[0].total_tokens(), 3);
        assert_eq!(entries[1].total_tokens(), 2);
        let explicit_total = parse_entry(
            &serde_json::json!({
                "timestamp": "2026-04-01T00:00:00.000Z",
                "message": { "role": "assistant", "usage": { "input": 2, "output": 3, "cacheRead": 5, "total": 99 } }
            }),
            "main",
            "live",
        )
        .unwrap();
        assert_eq!(explicit_total.total_tokens(), 99);
    }

    #[test]
    fn sorts_newest_entries_by_rfc3339_instant_across_offsets() {
        let root = TestRoot::new();
        root.session("main", "live.jsonl", concat!(
            r#"{"timestamp":"2026-04-01T00:30:00+02:00","message":{"role":"assistant","usage":{"total":1}}}"#, "\n",
            r#"{"timestamp":"2026-03-31T23:00:00Z","message":{"role":"assistant","usage":{"total":2}}}"#
        ));

        let entries = UsageHistory::new(&root.0).recent(1).unwrap();
        assert_eq!(entries.len(), 1);
        assert_eq!(entries[0].timestamp(), "2026-03-31T23:00:00Z");
    }

    #[test]
    fn preserves_subsecond_ordering_within_the_same_millisecond() {
        let root = TestRoot::new();
        root.session("main", "live.jsonl", concat!(
            r#"{"timestamp":"2026-04-01T00:00:00.000000001Z","message":{"role":"assistant","usage":{"total":1}}}"#, "\n",
            r#"{"timestamp":"2026-04-01T00:00:00.000000002Z","message":{"role":"assistant","usage":{"total":2}}}"#
        ));

        let entries = UsageHistory::new(&root.0).recent(1).unwrap();
        assert_eq!(entries[0].total_tokens(), 2);
    }

    #[test]
    fn rejects_unsafe_totals_and_overflowed_component_sums() {
        for usage in [
            serde_json::json!({ "total": MAX_SAFE_INTEGER + 1 }),
            serde_json::json!({ "input": MAX_SAFE_INTEGER, "output": 1 }),
        ] {
            assert!(
                parse_entry(
                    &serde_json::json!({
                        "timestamp": "2026-04-01T00:00:00.000Z",
                        "message": { "role": "assistant", "usage": usage },
                    }),
                    "main",
                    "live",
                )
                .is_none()
            );
        }
    }

    #[test]
    fn rejects_invalid_usage_shapes_without_projecting_raw_content() {
        let root = TestRoot::new();
        root.session("main", "live.jsonl", concat!(
            r#"{"timestamp":"not-a-timestamp","message":{"role":"assistant","usage":{"total":1}}}"#, "\n",
            r#"{"timestamp":"2026-04-01T00:00:00.000Z","message":{"role":"assistant","usage":"secret"}}"#, "\n",
            r#"{"timestamp":"2026-04-02T00:00:00.000Z","message":{"role":"assistant","usage":{"total":-1}}}"#, "\n",
            r#"{"timestamp":"2026-04-03T00:00:00.000Z","message":{"role":"assistant","usage":{"total":9007199254740992}}}"#
        ));
        assert!(UsageHistory::new(&root.0).recent(10).unwrap().is_empty());
    }
}
