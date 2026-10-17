use crate::{
    client::Client,
    session::{
        model::{SessionId, SessionRecord, valid_agent_id},
        rpc::{self, Failure},
    },
};
use serde_json::json;

pub(crate) async fn create(
    client: &Client,
    agent: &str,
    id: &SessionId,
) -> Result<SessionRecord, Failure> {
    if !valid_agent_id(agent) {
        return Err(Failure::InvalidInput);
    }
    let record: SessionRecord = rpc::decode(
        rpc::call(
            client,
            "sessions.create",
            json!({
                "agentId": agent, "sessionId": id.as_str(),
            }),
        )
        .await?,
    )?;
    if !record.validate(id.as_str(), Some(agent)) {
        return Err(Failure::InvalidReadback);
    }
    Ok(record)
}
