use serde_json::json;

use crate::{composition::PeerHandle, facade::ToolchainHandle, host_actor::Handle};

use super::{CommandOutcome, CommandResult, unavailable};

pub(super) async fn health(owner: &Handle) -> CommandOutcome {
    super::super::lifecycle::host_health(owner).await
}

pub(super) async fn runtime_snapshot(owner: &Handle, peer: &PeerHandle) -> CommandOutcome {
    super::super::lifecycle::runtime_snapshot(owner, peer).await
}

pub(super) async fn toolchain_status(toolchain: &ToolchainHandle) -> CommandOutcome {
    match toolchain.status().await {
        Ok(Ok(status)) => CommandOutcome::succeeded(CommandResult::private(json!({
            "result": toolchain_status_result(status)
        }))),
        Ok(Err(_)) | Err(_) => unavailable(),
    }
}

fn toolchain_status_result(status: toolchain::ToolchainStatus) -> serde_json::Value {
    json!({
        "uv": status.uv(),
        "python": status.python()
    })
}

pub(super) async fn toolchain_prepare(toolchain: &ToolchainHandle) -> CommandOutcome {
    match toolchain.prepare().await {
        Ok(Ok(toolchain::PrepareOutcome::Ready)) => CommandOutcome::succeeded(
            CommandResult::private(json!({ "result": { "outcome": "ready" } })),
        ),
        Ok(Ok(toolchain::PrepareOutcome::Installed)) => CommandOutcome::succeeded(
            CommandResult::private(json!({ "result": { "outcome": "installed" } })),
        ),
        Ok(Ok(toolchain::PrepareOutcome::Rejected)) => CommandOutcome::succeeded(
            CommandResult::private(json!({ "result": { "outcome": "rejected" } })),
        ),
        Ok(Ok(toolchain::PrepareOutcome::Unknown)) => CommandOutcome::succeeded(
            CommandResult::private(json!({ "result": { "outcome": "unknown" } })),
        ),
        Ok(Ok(toolchain::PrepareOutcome::Unavailable)) => unavailable(),
        Ok(Ok(toolchain::PrepareOutcome::Unsupported)) => unavailable(),
        Ok(Err(_)) | Err(_) => unavailable(),
    }
}
