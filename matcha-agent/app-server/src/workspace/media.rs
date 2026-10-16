use std::{
    collections::HashMap,
    sync::{Arc, Mutex},
    time::{Duration, Instant},
};

use serde::{Deserialize, Serialize};
use serde_json::json;
use uuid::Uuid;

use crate::{config::ConfigStore, rpc, session::Sessions};

const LIFETIME: Duration = Duration::from_secs(30);

type Entries = HashMap<(String, String, String), StoredMedia>;

#[derive(Clone, Default)]
pub struct Media(Arc<Mutex<Entries>>);

struct StoredMedia {
    bytes: Vec<u8>,
    expires_at: Instant,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct MediaUpload {
    pub file_name: String,
    pub mime_type: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MediaReceipt {
    pub reference: String,
    pub name: String,
    pub mime_type: String,
    pub size: u64,
}

impl Media {
    pub async fn stage(
        &self,
        config: &ConfigStore,
        sessions: &Sessions,
        agent_id: &str,
        session_id: &str,
        metadata: MediaUpload,
        bytes: Vec<u8>,
    ) -> rpc::Result<MediaReceipt> {
        super::access::validate_segment(&metadata.file_name)?;
        if metadata.mime_type.is_empty()
            || !metadata.mime_type.is_ascii()
            || metadata.mime_type.chars().any(char::is_control)
        {
            return Err(rpc::Error::invalid("A valid media MIME type is required"));
        }
        let _guard = sessions.agent_guard(agent_id).await;
        authorize(config, sessions, agent_id, session_id).await?;
        let receipt = MediaReceipt {
            reference: format!("media_{}", Uuid::new_v4().simple()),
            name: metadata.file_name,
            mime_type: metadata.mime_type,
            size: bytes.len() as u64,
        };
        let now = Instant::now();
        let mut entries = self.0.lock().map_err(|_| unavailable())?;
        entries.retain(|_, entry| entry.expires_at > now);
        entries.insert(
            (
                agent_id.to_owned(),
                session_id.to_owned(),
                receipt.reference.clone(),
            ),
            StoredMedia {
                bytes,
                expires_at: now + LIFETIME,
            },
        );
        Ok(receipt)
    }

    /// Resolving is a single consumption, including when delivery of the HTTP response is lost.
    pub async fn take(
        &self,
        config: &ConfigStore,
        sessions: &Sessions,
        agent_id: &str,
        session_id: &str,
        reference: &str,
    ) -> rpc::Result<Vec<u8>> {
        if reference.len() != 38
            || !reference.starts_with("media_")
            || !reference.as_bytes()[6..].iter().all(u8::is_ascii_hexdigit)
        {
            return Err(rpc::Error::invalid("The media reference is invalid"));
        }
        let _guard = sessions.agent_guard(agent_id).await;
        authorize(config, sessions, agent_id, session_id).await?;
        let now = Instant::now();
        let mut entries = self.0.lock().map_err(|_| unavailable())?;
        entries.retain(|_, entry| entry.expires_at > now);
        entries
            .remove(&(
                agent_id.to_owned(),
                session_id.to_owned(),
                reference.to_owned(),
            ))
            .map(|entry| entry.bytes)
            .ok_or_else(|| rpc::Error::not_found("Staged media"))
    }

    pub fn clear_session(&self, session_id: &str) -> rpc::Result<()> {
        self.0
            .lock()
            .map_err(|_| unavailable())?
            .retain(|(_, owner, _), _| owner != session_id);
        Ok(())
    }
}

async fn authorize(
    config: &ConfigStore,
    sessions: &Sessions,
    agent_id: &str,
    session_id: &str,
) -> rpc::Result<()> {
    crate::config::validate_id(agent_id)?;
    if !config.snapshot().await.agents.contains_key(agent_id) {
        return Err(rpc::Error::not_found("Agent"));
    }
    let record = sessions
        .dispatch("sessions.get", json!({ "sessionId": session_id }))
        .await?;
    if record.get("agentId").and_then(serde_json::Value::as_str) != Some(agent_id) {
        return Err(rpc::Error::new(
            -32007,
            "workspace_session_mismatch",
            "The session does not belong to the selected Agent",
        ));
    }
    Ok(())
}

fn unavailable() -> rpc::Error {
    rpc::Error::unavailable("workspace_media_unavailable", "Staged media is unavailable")
}
