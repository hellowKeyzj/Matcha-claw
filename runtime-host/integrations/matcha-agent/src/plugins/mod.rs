mod adapter;

use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use tokio_util::sync::CancellationToken;

use crate::client::{Client, Delivery, Error};

#[derive(Clone)]
pub struct Plugins { client: Client }

#[derive(Clone, Copy, Serialize, Deserialize)]
#[serde(rename_all="lowercase")]
pub enum Scope { User, Project, Local, Managed }

#[derive(Clone, Copy)]
pub enum Operation { Install, Enable, Disable, Update, Uninstall }

impl Operation {
    fn method(self) -> &'static str {
        match self {Self::Install=>"plugins.install",Self::Enable=>"plugins.enable",Self::Disable=>"plugins.disable",Self::Update=>"plugins.update",Self::Uninstall=>"plugins.uninstall"}
    }
    fn name(self) -> &'static str {self.method().strip_prefix("plugins.").expect("fixed plugin method")}
}

#[derive(Deserialize)]
#[serde(rename_all="camelCase")]
pub struct Catalog { pub agent_id: String, pub plugins: Vec<Plugin>, pub session_state: String }

#[derive(Deserialize)]
#[serde(rename_all="camelCase")]
pub struct Plugin { pub id: String, pub version: String, pub scope: String, pub enabled: bool, pub error_count: u64 }

#[derive(Deserialize)]
#[serde(rename_all="camelCase")]
pub struct Receipt {
    pub agent_id: String,
    pub operation: String,
    pub status: String,
    pub session_refresh: String,
    // The server projects only native command receipt fields, never raw stdout/errors.
    pub result: Value,
}

#[derive(Deserialize)]
#[serde(rename_all="camelCase")]
pub struct Reload {
    pub session_id: String,
    pub status: String,
    #[serde(rename="error_count")]
    pub error_count: u64,
    pub observation_completeness: String,
    pub commands: Vec<Name>,
    pub agents: Vec<Name>,
    pub plugins: Vec<LoadedPlugin>,
    pub mcp_servers: Vec<Mcp>,
}

#[derive(Deserialize)]
pub struct Name { pub name: String }
#[derive(Deserialize)]
pub struct LoadedPlugin { pub name: String, pub source: Option<String> }
#[derive(Deserialize)]
#[serde(rename_all="camelCase")]
pub struct Mcp { pub name: String, pub status: String, pub error_present: bool }

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum Failure { Rejected, Unavailable, Observation, Unknown { changes_may_be_partial: bool } }

impl Plugins {
    pub fn new(client: Client) -> Self {Self {client}}

    pub async fn list(&self, agent: &str) -> Result<Catalog, Failure> {
        let response = self.client.call("plugins.list",json!({"agentId":agent})).await.map_err(failure)?;
        let catalog: Catalog = serde_json::from_value(response).map_err(|_|Failure::Observation)?;
        if catalog.agent_id != agent || catalog.session_state != "not_observed" {return Err(Failure::Observation);}
        Ok(catalog)
    }

    pub async fn mutate(&self, agent: &str, operation: Operation, id: &str, scope: Option<Scope>, cancellation: &CancellationToken) -> Result<Receipt, Failure> {
        let response = self.client.call_cancellable(operation.method(),json!({"agentId":agent,"id":id,"scope":scope}),cancellation).await.map_err(failure)?;
        receipt(response,agent,operation.name())
    }

    pub async fn disable_all(&self, agent: &str, cancellation: &CancellationToken) -> Result<Receipt, Failure> {
        let response = self.client.call_cancellable("plugins.disable",json!({"agentId":agent,"all":true}),cancellation).await.map_err(failure)?;
        receipt(response,agent,"disable")
    }

    pub async fn reload(&self, session: &str, cancellation: &CancellationToken) -> Result<Reload, Failure> {
        let response = self.client.call_cancellable("plugins.reload",json!({"sessionId":session}),cancellation).await.map_err(failure)?;
        let observed: Reload = serde_json::from_value(response).map_err(|_|Failure::Unknown {changes_may_be_partial:true})?;
        if observed.session_id != session || !matches!(observed.status.as_str(),"refreshed"|"partial") || observed.observation_completeness != "best_effort" {return Err(Failure::Unknown {changes_may_be_partial:true});}
        Ok(observed)
    }
}

fn receipt(response: Value, agent: &str, operation: &str) -> Result<Receipt, Failure> {
    let receipt: Receipt = serde_json::from_value(response).map_err(|_|Failure::Unknown {changes_may_be_partial:true})?;
    if receipt.agent_id != agent || receipt.operation != operation || receipt.status != "native_succeeded" || receipt.session_refresh != "not_requested" {return Err(Failure::Unknown {changes_may_be_partial:true});}
    Ok(receipt)
}

fn failure(error: Error) -> Failure {
    if error.data().is_some_and(|data|data.get("changesMayBePartial").and_then(Value::as_bool)==Some(true) || data.get("reloadOutcome").and_then(Value::as_str)==Some("unconfirmed")) {
        return Failure::Unknown {changes_may_be_partial:true};
    }
    match error.code() {
        Some(-32602|-32001|-32002|-32007)=>Failure::Rejected,
        Some(-32601|-32003)=>Failure::Unavailable,
        _ if error.delivery()==Delivery::NotSent=>Failure::Unavailable,
        _=>Failure::Unknown {changes_may_be_partial:true},
    }
}
