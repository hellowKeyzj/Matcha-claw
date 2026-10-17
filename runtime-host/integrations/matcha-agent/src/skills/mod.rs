mod adapter;
mod bundles;
mod marketplace;
mod management;
mod upload;
pub mod memory;
pub mod prompt;

pub use marketplace::Marketplace;

use serde::Deserialize;
use serde_json::{Value, json};
use tokio_util::sync::CancellationToken;

use crate::client::{Client, Delivery, Error};

#[derive(Clone)]
pub struct Skills {
    client: Client,
    marketplace: Option<Marketplace>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Skill {
    pub scope: String,
    pub agent_id: String,
    pub name: String,
    pub source: String,
    pub loaded_from: String,
    pub path: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Catalog {
    pub scope: String,
    pub agent_id: String,
    pub skills: Vec<Skill>,
    pub application: Application,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Application {
    pub target: String,
    pub current_sessions: String,
    pub native_policy: String,
    pub conditions: Vec<String>,
    pub runtime_verification: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Bundle {
    pub skill: Skill,
    pub bundle_sha256: String,
    pub skill_md: String,
    pub resources: Vec<Resource>,
    pub application: Application,
}

#[derive(serde::Serialize, Deserialize)]
pub struct Resource {
    pub path: String,
    pub bytes: Vec<u8>,
}

#[derive(Deserialize)]
pub struct Mutation {
    pub skill: Skill,
    #[serde(default)]
    pub materialized: bool,
    #[serde(default)]
    pub removed: bool,
    pub application: Application,
}

impl Skills {
    pub fn new(client: Client) -> Self {
        Self { client, marketplace: None }
    }

    pub fn with_marketplace(mut self, marketplace: Marketplace) -> Self {
        self.marketplace = Some(marketplace);
        self
    }

    pub async fn list(&self, agent_id: &str) -> Result<Catalog, ResourceError> {
        let response = self.client.call("skills.list", json!({"scope":"agent", "agentId":agent_id})).await.map_err(ResourceError::from)?;
        let catalog: Catalog = serde_json::from_value(response).map_err(|_| ResourceError::Observation)?;
        if catalog.scope != "agent" || catalog.agent_id != agent_id || catalog.skills.iter().any(|skill| !skill.belongs_to(agent_id)) {
            return Err(ResourceError::Observation);
        }
        Ok(catalog)
    }

    pub async fn get(&self, agent_id: &str, name: &str) -> Result<Bundle, ResourceError> {
        let response = self.client.call("skills.get", json!({"scope":"agent", "agentId":agent_id, "name":name})).await.map_err(ResourceError::from)?;
        let bundle: Bundle = serde_json::from_value(response).map_err(|_| ResourceError::Observation)?;
        if !bundle.skill.belongs_to(agent_id) || bundle.skill.name != name
            || bundle.bundle_sha256.len() != 64
            || !bundle.bundle_sha256.bytes().all(|b| matches!(b, b'0'..=b'9' | b'a'..=b'f')) {
            return Err(ResourceError::Observation);
        }
        Ok(bundle)
    }

    pub async fn install(&self, agent_id: &str, name: &str, skill_md: String, resources: Vec<Resource>, cancellation: &CancellationToken) -> Result<Mutation, ResourceError> {
        self.install_source(agent_id, name, json!({"type":"content", "skillMd":skill_md, "resources":resources}), false, cancellation).await
    }

    async fn install_source(&self, agent_id: &str, name: &str, source: Value, replace: bool, cancellation: &CancellationToken) -> Result<Mutation, ResourceError> {
        let response = self.client.call_cancellable("skills.install", json!({"scope":"agent", "agentId":agent_id, "name":name, "trust":true, "source":source, "replace":replace}), cancellation).await.map_err(ResourceError::from)?;
        let mutation: Mutation = serde_json::from_value(response).map_err(|_| ResourceError::Unknown)?;
        if !mutation.materialized || !mutation.skill.belongs_to(agent_id) || mutation.skill.name != name {
            return Err(ResourceError::Unknown);
        }
        Ok(mutation)
    }

    pub async fn remove(&self, agent_id: &str, name: &str, cancellation: &CancellationToken) -> Result<Mutation, ResourceError> {
        self.remove_source(agent_id, name, None, cancellation).await
    }

    pub async fn remove_source(&self, agent_id: &str, name: &str, expected_sha256: Option<&str>, cancellation: &CancellationToken) -> Result<Mutation, ResourceError> {
        let response = self.client.call_cancellable("skills.remove", json!({"scope":"agent", "agentId":agent_id, "name":name, "expectedSha256":expected_sha256}), cancellation).await.map_err(ResourceError::from)?;
        let mutation: Mutation = serde_json::from_value(response).map_err(|_| ResourceError::Unknown)?;
        if !mutation.removed || !mutation.skill.belongs_to(agent_id) || mutation.skill.name != name {
            return Err(ResourceError::Unknown);
        }
        Ok(mutation)
    }
}

impl Skill {
    fn belongs_to(&self, agent_id: &str) -> bool {
        self.scope == "agent" && self.agent_id == agent_id
            && self.source == "userSettings" && self.loaded_from == "skills"
            && !self.name.is_empty() && !self.name.contains(['/', '\\'])
            && self.path == format!("skills/{}/SKILL.md", self.name)
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum ResourceError {
    Rejected,
    NotFound,
    Unavailable,
    Observation,
    Unknown,
}

impl From<Error> for ResourceError {
    fn from(error: Error) -> Self {
        if error.code() == Some(-32001) { return Self::NotFound; }
        if error.data().is_some_and(|data| data.get("nativeDirectoryRemoved") == Some(&json!(true)) || data.get("changesMayBePartial") == Some(&json!(true))) {
            return Self::Unknown;
        }
        match error.code() {
            Some(-32602 | -32002 | -32007) => Self::Rejected,
            Some(-32003 | -32601) => Self::Unavailable,
            _ if error.delivery() == Delivery::NotSent => Self::Unavailable,
            _ => Self::Unknown,
        }
    }
}
