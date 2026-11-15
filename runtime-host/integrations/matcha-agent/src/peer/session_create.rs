use crate::{
    client::Client,
    session::{
        model::{SessionId, SessionRecord, valid_agent_id},
        rpc::{self, Failure},
    },
};
use serde_json::json;
use std::path::Path;

pub(crate) async fn create(
    client: &Client,
    agent: &str,
    id: &SessionId,
    cwd: Option<&Path>,
) -> Result<SessionRecord, Failure> {
    if !valid_agent_id(agent)
        || cwd.is_some_and(|cwd| !cwd.is_absolute() || cwd.to_str().is_none_or(|cwd| cwd.contains('\0')))
    {
        return Err(Failure::InvalidInput);
    }
    let mut params = json!({"agentId": agent, "sessionId": id.as_str()});
    if let Some(cwd) = cwd {
        params["cwd"] = json!(cwd);
    }
    let record: SessionRecord = rpc::decode(
        rpc::call(client, "sessions.create", params).await?,
    )?;
    if !record.validate(id.as_str(), Some(agent))
        || cwd.is_some_and(|cwd| Path::new(&record.cwd) != cwd)
    {
        return Err(Failure::InvalidReadback);
    }
    Ok(record)
}
