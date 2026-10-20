use std::{collections::BTreeMap, path::PathBuf, sync::Arc};

use serde::{Deserialize, Serialize};
use serde_json::{Value, json};

use crate::rpc;

use super::{Execution, Session, Sessions, history, record};

#[derive(Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub(super) struct Projection {
    pub custom: Option<String>,
    pub ai: Option<String>,
    pub fallback: Option<String>,
}

impl Sessions {
    pub(super) async fn accept_title_locked(
        &self,
        execution: &mut Execution,
        message: &Value,
    ) -> rpc::Result<Option<String>> {
        if execution.record.title_attempted {
            return Ok(None);
        }
        let Some(text) = user_text(message) else {
            return Ok(None);
        };
        let Some(projection) = &execution.record.native_title else {
            return Ok(None);
        };
        let generate = execution.record.title.is_none()
            && projection.custom.is_none()
            && projection.ai.is_none();
        let mut updated = execution.record.clone();
        updated.title_attempted = true;
        if generate {
            updated
                .native_title
                .as_mut()
                .expect("new session projection")
                .fallback = Some(short_prompt(&text));
        }
        // Fence this first message even if storage fails. Never start a model
        // request without the durable marker, or retry it on a later ACK.
        execution.record.title_attempted = true;
        record::save_session(&self.0.database, &updated).await?;
        let changed = updated.native_title != execution.record.native_title;
        execution.record = updated;
        if changed {
            self.0.catalog_changes.send_replace(());
        }
        Ok(generate.then_some(text))
    }

    pub(super) async fn generate_title(
        &self,
        session: Arc<Session>,
        instance_id: String,
        description: String,
    ) {
        let record = session.data.lock().await.record.clone();
        let result = self
            .generate_title_inner(&session, &instance_id, &record, description)
            .await;
        if let Err(error) = result {
            self.title_failure(&record, &instance_id, &error).await;
        }
    }

    async fn generate_title_inner(
        &self,
        session: &Session,
        instance_id: &str,
        record: &record::Record,
        description: String,
    ) -> rpc::Result<()> {
        let metadata =
            history::metadata(&record.runtime, &record.workspace, &record.session_id).await?;
        self.project_title(session, metadata).await?;
        let control = {
            let execution = session.data.lock().await;
            let projection = execution
                .record
                .native_title
                .as_ref()
                .expect("new session projection");
            if execution.closing
                || execution.record.status != record::Status::Open
                || execution.record.title.is_some()
                || projection.custom.is_some()
                || projection.ai.is_some()
                || self.0.shutdown.load(std::sync::atomic::Ordering::Acquire)
            {
                return Ok(());
            }
            let Some(cli) = execution
                .cli
                .as_ref()
                .filter(|cli| cli.instance_id() == instance_id)
            else {
                return Ok(());
            };
            cli.admit()?
        };
        let response = control
            .request(json!({
                "subtype": "generate_session_title", "description": description, "persist": true,
            }))
            .await?;
        if response
            .get("title")
            .and_then(Value::as_str)
            .is_none_or(|title| title.trim().is_empty())
        {
            return Ok(());
        }
        // The native save is best-effort. The response title alone is not proof
        // of persistence; project only the ai-title actually present in JSONL.
        let metadata =
            history::metadata(&record.runtime, &record.workspace, &record.session_id).await?;
        if metadata.ai.is_none() {
            return Err(rpc::Error::unavailable(
                "session_title_not_persisted",
                "The generated title was not found in native metadata",
            ));
        }
        self.project_title(session, metadata).await.map(|_| ())
    }

    pub(super) async fn hydrate_titles(&self, records: &mut [record::Record]) {
        let mut groups = BTreeMap::<(PathBuf, PathBuf), Vec<usize>>::new();
        for (index, record) in records.iter().enumerate() {
            if record.native_title.is_none() && record.status != record::Status::Deleting {
                groups
                    .entry((record.runtime.clone(), record.workspace.clone()))
                    .or_default()
                    .push(index);
            }
        }
        for ((runtime, workspace), indices) in groups {
            let ids = indices
                .iter()
                .map(|index| records[*index].session_id.clone())
                .collect();
            let projections = match history::metadata_batch(&runtime, &workspace, ids).await {
                Ok(projections) => projections,
                Err(error) => {
                    for index in indices {
                        self.title_metadata_failure(&records[index], &error).await;
                    }
                    continue;
                }
            };
            for (index, metadata) in indices.into_iter().zip(projections) {
                let metadata = match metadata {
                    Ok(metadata) => metadata,
                    Err(error) => {
                        self.title_metadata_failure(&records[index], &error).await;
                        continue;
                    }
                };
                let session = self
                    .0
                    .sessions
                    .read()
                    .await
                    .get(&records[index].session_id)
                    .cloned();
                if let Some(session) = session {
                    match self.project_title(&session, metadata).await {
                        Ok(record) => records[index] = record,
                        Err(error) => self.title_metadata_failure(&records[index], &error).await,
                    }
                }
            }
        }
    }

    async fn project_title(
        &self,
        session: &Session,
        metadata: Projection,
    ) -> rpc::Result<record::Record> {
        let mut execution = session.data.lock().await;
        if execution.record.status == record::Status::Deleting || metadata == Projection::default()
        {
            return Ok(execution.record.clone());
        }
        let mut updated = execution.record.clone();
        let projection = updated.native_title.get_or_insert_with(Projection::default);
        if metadata.custom.is_some() {
            projection.custom = metadata.custom;
        }
        if metadata.ai.is_some() {
            projection.ai = metadata.ai;
        }
        if projection.fallback.is_none() {
            projection.fallback = metadata.fallback;
        }
        if updated.native_title != execution.record.native_title {
            record::save_session(&self.0.database, &updated).await?;
            execution.record = updated;
            self.0.catalog_changes.send_replace(());
        }
        Ok(execution.record.clone())
    }

    async fn title_metadata_failure(&self, record: &record::Record, error: &rpc::Error) {
        if self.0.diagnostics.record("session", "title", "session_title_metadata_failed", json!({
            "sessionId": record.session_id, "agentId": record.agent_id,
            "causeCode": error.code, "causeKind": error.data.as_ref().and_then(|data| data.get("kind")),
        })).await.is_err() {
            eprintln!("session title diagnostic could not be persisted");
        }
    }

    pub(super) async fn title_failure(
        &self,
        record: &record::Record,
        instance_id: &str,
        error: &rpc::Error,
    ) {
        if self.0.diagnostics.record("session", "title", "session_title_failed", json!({
            "sessionId": record.session_id, "agentId": record.agent_id, "instanceId": instance_id,
            "causeCode": error.code, "causeKind": error.data.as_ref().and_then(|data| data.get("kind")),
        })).await.is_err() {
            eprintln!("session title diagnostic could not be persisted");
        }
    }
}

enum UserText {
    Prose(String),
    Bash(String),
    Command(String),
}

pub(super) fn user_text(message: &Value) -> Option<String> {
    user_texts(message).find_map(|text| match text {
        UserText::Prose(text) => Some(text),
        _ => None,
    })
}

// Native first-prompt parsing is shared by metadata and acknowledged user input;
// only prose is eligible for the one AI attempt (sessionStoragePortable.ts).
fn user_texts(message: &Value) -> impl Iterator<Item = UserText> + '_ {
    let content = if message["type"] != "user"
        || message["isMeta"] == true
        || message["isCompactSummary"] == true
        || message["isSidechain"] == true
        || message["isSynthetic"] == true
        || message
            .pointer("/origin/kind")
            .and_then(Value::as_str)
            .is_some_and(|kind| kind != "human")
        || message
            .get("parent_tool_use_id")
            .is_some_and(|id| !id.is_null())
    {
        None
    } else {
        Some(&message["message"]["content"])
    };
    let texts: Vec<_> = match content {
        Some(Value::String(text)) => vec![text.as_str()],
        Some(Value::Array(blocks))
            if !blocks.iter().any(|block| block["type"] == "tool_result") =>
        {
            blocks
                .iter()
                .filter(|block| block["type"] == "text")
                .filter_map(|block| block["text"].as_str())
                .collect()
        }
        _ => Vec::new(),
    };
    texts.into_iter().filter_map(|raw| {
        let text = raw.replace('\n', " ");
        let text = text.trim();
        if text.is_empty() {
            return None;
        }
        if let Some(command) = tag(text, "command-name") {
            return (!command.is_empty()).then(|| UserText::Command(command.to_owned()));
        }
        if let Some(bash) = tag(text, "bash-input") {
            return Some(UserText::Bash(bash.trim().to_owned()));
        }
        let mut chars = text.strip_prefix('<').unwrap_or_default().chars();
        let xml = chars.next().is_some_and(|first| first.is_ascii_lowercase())
            && chars
                .skip_while(|ch| ch.is_ascii_alphanumeric() || matches!(ch, '_' | '-'))
                .next()
                .is_some_and(|ch| ch.is_whitespace() || ch == '>');
        if xml || (text.starts_with("[Request interrupted by user") && text.contains(']')) {
            return None;
        }
        Some(UserText::Prose(text.to_owned()))
    })
}

fn tag<'a>(text: &'a str, name: &str) -> Option<&'a str> {
    text.split_once(&format!("<{name}>"))?
        .1
        .split_once(&format!("</{name}>"))
        .map(|(value, _)| value)
}

fn short_prompt(text: &str) -> String {
    let end = text
        .char_indices()
        .scan(0, |units, (index, ch)| {
            *units += ch.len_utf16();
            Some((index, *units))
        })
        .find(|(_, units)| *units > 200)
        .map(|(index, _)| index);
    match end {
        Some(end) => format!("{}…", text[..end].trim_end()),
        None => text.to_owned(),
    }
}

pub(super) fn metadata(head: &[u8], tail: &[u8], session_id: &str) -> Projection {
    fn fields(bytes: &[u8], session_id: &str) -> (Projection, Option<String>) {
        let mut projection = Projection::default();
        let mut summary = None;
        for line in bytes.split(|byte| *byte == b'\n') {
            let Ok(entry) = serde_json::from_slice::<Value>(line) else {
                continue;
            };
            let value = |field: &str| {
                entry[field]
                    .as_str()
                    .filter(|value| !value.trim().is_empty())
                    .map(str::to_owned)
            };
            match entry["type"].as_str() {
                Some("custom-title") if entry["sessionId"] == session_id => {
                    projection.custom = value("customTitle")
                }
                Some("ai-title") if entry["sessionId"] == session_id => {
                    projection.ai = value("aiTitle")
                }
                Some("last-prompt") if entry["sessionId"] == session_id => {
                    projection.fallback = value("lastPrompt")
                }
                Some("summary") => summary = value("summary"),
                Some("task-summary") if entry["sessionId"] == session_id => {
                    summary = value("summary")
                }
                _ => {}
            }
        }
        (projection, summary)
    }
    let (head_fields, _) = fields(head, session_id);
    let (tail_fields, summary) = fields(tail, session_id);
    Projection {
        custom: tail_fields.custom.or(head_fields.custom),
        ai: tail_fields.ai.or(head_fields.ai),
        fallback: tail_fields.fallback.or(summary).or_else(|| {
            let mut command = None;
            for entry in head
                .split(|byte| *byte == b'\n')
                .filter_map(|line| serde_json::from_slice::<Value>(line).ok())
            {
                for text in user_texts(&entry) {
                    match text {
                        UserText::Prose(text) => return Some(short_prompt(&text)),
                        UserText::Bash(text) => return Some(format!("! {text}")),
                        UserText::Command(text) => {
                            command.get_or_insert(text);
                        }
                    }
                }
            }
            command
        }),
    }
}
