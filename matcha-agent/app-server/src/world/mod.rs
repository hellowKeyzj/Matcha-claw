mod investigation;

use std::path::PathBuf;

use serde::Serialize;

pub(crate) use investigation::verify_investigation;

use crate::{
    cli::{LaunchSpec, process::Launch},
    rpc::{self, Error},
};

/// Only a real CLI launch receives identity; no request can ask the server to sign arbitrary facts.
pub(crate) fn inject(launch: &mut Launch, spec: &LaunchSpec, instance_id: &str) -> rpc::Result<()> {
    let Some(projection) = std::env::var_os("MATCHA_WORLD_PROJECTION") else {
        return Ok(());
    };
    let projection = PathBuf::from(projection);
    if !projection.is_absolute() {
        return Err(Error::invalid(
            "World private projection must be an absolute path",
        ));
    }
    crate::config::validate_id(&spec.agent_id)?;
    if !spec.config.agents.contains_key(&spec.agent_id) {
        return Err(Error::not_found("Agent"));
    }
    #[derive(Serialize)]
    #[serde(rename_all = "camelCase")]
    struct Context<'a> {
        agent_id: &'a str,
        session_id: &'a str,
        instance_id: &'a str,
        workspace: &'a str,
    }
    let workspace = launch
        .cwd
        .to_str()
        .ok_or_else(|| Error::invalid("World workspace must be Unicode"))?;
    let context = serde_json::to_string(&Context {
        agent_id: &spec.agent_id,
        session_id: &spec.session_id,
        instance_id,
        workspace,
    })
    .map_err(|cause| Error::internal("world_launch_context").with_source(cause))?;
    let projection = projection
        .into_os_string()
        .into_string()
        .map_err(|_| Error::invalid("World private projection path must be Unicode"))?;
    launch
        .env
        .insert("MATCHA_WORLD_PROJECTION".into(), projection);
    launch.env.insert("MATCHA_WORLD_CONTEXT".into(), context);
    Ok(())
}
