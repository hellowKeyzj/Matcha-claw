use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use tokio_util::sync::CancellationToken;

use super::{ResourceError, Skills, memory::Entry};

#[derive(Deserialize)]
#[serde(rename_all="camelCase")]
pub struct Prompt {
    pub agent_id: String,
    pub system_prompt: Option<String>,
    pub append_system_prompt: Option<String>,
    pub default_source: String,
    pub execution_projection: String,
    pub apply: String,
    pub live_reload: bool,
    pub persisted: Option<bool>,
}

#[derive(Clone, Copy, Serialize, Deserialize)]
#[serde(rename_all="lowercase")]
pub enum Scope { Workspace, User }

#[derive(Deserialize)]
#[serde(rename_all="camelCase")]
pub struct Instructions {
    pub agent_id: String,
    pub scope: Scope,
    pub discovery: String,
    pub external_includes: String,
    pub native_consumption: String,
    pub directory: Option<String>,
    pub files: Option<Vec<Entry>>,
    pub path: Option<String>,
    pub content: Option<String>,
    pub persisted: Option<bool>,
    pub apply: Option<String>,
    pub live_reload: Option<bool>,
}

impl Skills {
    pub async fn prompt_get(&self, agent: &str) -> Result<Prompt, ResourceError> {
        self.prompt("prompts.get",agent,json!({"agentId":agent}),false,&CancellationToken::new()).await
    }
    pub async fn prompt_set(&self, agent: &str, system: Option<&str>, append: Option<&str>, cancellation: &CancellationToken) -> Result<Prompt, ResourceError> {
        self.prompt("prompts.set",agent,json!({"agentId":agent,"systemPrompt":system,"appendSystemPrompt":append}),true,cancellation).await
    }
    async fn prompt(&self, method: &str, agent: &str, params: Value, write: bool, cancellation: &CancellationToken) -> Result<Prompt, ResourceError> {
        let response = self.client.call_cancellable(method,params,cancellation).await.map_err(ResourceError::from)?;
        let invalid = if write{ResourceError::Unknown}else{ResourceError::Observation};
        let prompt: Prompt = serde_json::from_value(response).map_err(|_|invalid)?;
        if prompt.agent_id!=agent || prompt.default_source!="native_builder" || prompt.execution_projection!="native_initialize"
            || prompt.apply!="next_session" || prompt.live_reload || write && prompt.persisted!=Some(true) {return Err(invalid);}
        Ok(prompt)
    }
    pub async fn instructions_list(&self, agent: &str, scope: Scope, directory: &str) -> Result<Instructions, ResourceError> {
        self.instructions("instructions.list",agent,json!({"agentId":agent,"scope":scope,"directory":directory}),false,&CancellationToken::new()).await
    }
    pub async fn instructions_read(&self, agent: &str, scope: Scope, path: &str) -> Result<Instructions, ResourceError> {
        self.instructions("instructions.read",agent,json!({"agentId":agent,"scope":scope,"path":path}),false,&CancellationToken::new()).await
    }
    pub async fn instructions_write(&self, agent: &str, scope: Scope, path: &str, content: &str, cancellation: &CancellationToken) -> Result<Instructions, ResourceError> {
        self.instructions("instructions.write",agent,json!({"agentId":agent,"scope":scope,"path":path,"content":content}),true,cancellation).await
    }
    async fn instructions(&self, method: &str, agent: &str, params: Value, write: bool, cancellation: &CancellationToken) -> Result<Instructions, ResourceError> {
        let response = self.client.call_cancellable(method,params,cancellation).await.map_err(ResourceError::from)?;
        let invalid = if write{ResourceError::Unknown}else{ResourceError::Observation};
        let instructions: Instructions = serde_json::from_value(response).map_err(|_|invalid)?;
        if instructions.agent_id!=agent || instructions.discovery!="managed_candidates_not_loaded_cache" || instructions.external_includes!="not_followed"
            || write && (instructions.persisted!=Some(true) || instructions.apply.as_deref()!=Some("next_session") || instructions.live_reload!=Some(false)) {return Err(invalid);}
        Ok(instructions)
    }
}
