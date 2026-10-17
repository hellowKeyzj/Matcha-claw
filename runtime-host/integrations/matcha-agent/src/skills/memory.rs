use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use tokio_util::sync::CancellationToken;

use super::{ResourceError, Skills};

#[derive(Clone, Copy, Serialize, Deserialize)]
#[serde(rename_all="lowercase")]
pub enum Scope { Auto, User, Project, Local }

#[derive(Deserialize)]
#[serde(rename_all="camelCase")]
pub struct Entry { pub path: String, pub bytes: u64, pub modified_at_ms: Option<u64> }

#[derive(Deserialize)]
#[serde(rename_all="camelCase")]
pub struct Memory {
    pub agent_id: String,
    pub scope: Scope,
    pub name: Option<String>,
    pub storage: String,
    pub entrypoint: String,
    pub index_managed: bool,
    pub native_consumption: String,
    pub files: Option<Vec<Entry>>,
    pub path: Option<String>,
    pub content: Option<String>,
    pub persisted: Option<bool>,
    pub apply: Option<String>,
    pub live_reload: Option<bool>,
}

impl Skills {
    pub async fn memory_list(&self, agent: &str, scope: Scope, name: Option<&str>) -> Result<Memory, ResourceError> {
        self.memory("memory.list",agent,json!({"agentId":agent,"scope":scope,"name":name}),false,&CancellationToken::new()).await
    }
    pub async fn memory_read(&self, agent: &str, scope: Scope, name: Option<&str>, path: &str) -> Result<Memory, ResourceError> {
        self.memory("memory.read",agent,json!({"agentId":agent,"scope":scope,"name":name,"path":path}),false,&CancellationToken::new()).await
    }
    pub async fn memory_write(&self, agent: &str, scope: Scope, name: Option<&str>, path: &str, content: &str, cancellation: &CancellationToken) -> Result<Memory, ResourceError> {
        self.memory("memory.write",agent,json!({"agentId":agent,"scope":scope,"name":name,"path":path,"content":content}),true,cancellation).await
    }
    pub async fn memory_delete(&self, agent: &str, scope: Scope, name: Option<&str>, path: &str, cancellation: &CancellationToken) -> Result<Memory, ResourceError> {
        self.memory("memory.delete",agent,json!({"agentId":agent,"scope":scope,"name":name,"path":path}),true,cancellation).await
    }
    async fn memory(&self, method: &str, agent: &str, params: Value, write: bool, cancellation: &CancellationToken) -> Result<Memory, ResourceError> {
        let response = self.client.call_cancellable(method,params,cancellation).await.map_err(ResourceError::from)?;
        let invalid = if write{ResourceError::Unknown}else{ResourceError::Observation};
        let memory: Memory = serde_json::from_value(response).map_err(|_|invalid)?;
        if memory.agent_id!=agent || memory.storage!="native_text_files" || memory.index_managed
            || write && (memory.persisted!=Some(true) || memory.apply.as_deref()!=Some("next_session") || memory.live_reload!=Some(false)) {return Err(invalid);}
        Ok(memory)
    }
}
