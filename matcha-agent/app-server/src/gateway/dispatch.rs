use super::Gateway;
use crate::{
    agent, channel, config, mcp, memory, plugin, policy, prompt, provider, retention, rpc,
    schedule, search, sealed, skill, task, team, tool, usage, workflow, workspace,
};
use serde_json::{Value, json};

// This is the advertised, wired surface, not the CLI's full native method catalogue.
const METHODS: &[&str] = &[
    "initialize",
    "server.capabilities",
    "server.shutdown",
    "config.get",
    "config.update",
    "search.project",
    "search.observe",
    "agents.list",
    "agents.get",
    "agents.create",
    "agents.update",
    "agents.delete",
    "agents.retire",
    "agents.mutate",
    "agents.configuration",
    "agents.deletion.get",
    "agents.files.list",
    "agents.files.get",
    "agents.files.set",
    "agents.tools.get",
    "agents.tools.set",
    "workspace.list",
    "workspace.stat",
    "workspace.read",
    "workspace.write",
    "workspace.mkdir",
    "workspace.remove",
    "memory.list",
    "memory.read",
    "memory.write",
    "memory.delete",
    "prompts.get",
    "prompts.set",
    "instructions.list",
    "instructions.read",
    "instructions.write",
    "skills.list",
    "skills.get",
    "skills.install",
    "skills.remove",
    "skills.upload.begin",
    "skills.upload.chunk",
    "skills.upload.commit",
    "sealedSkills.project",
    "plugins.list",
    "plugins.install",
    "plugins.uninstall",
    "plugins.enable",
    "plugins.disable",
    "plugins.update",
    "plugins.reload",
    "mcp.list",
    "mcp.get",
    "mcp.add",
    "mcp.remove",
    "mcp.status",
    "mcp.reconnect",
    "mcp.toggle",
    "mcp.authenticate",
    "mcp.config.get",
    "mcp.config.set",
    "providers.list",
    "providers.get",
    "providers.set",
    "providers.remove",
    "providers.project",
    "models.list",
    "auth.status",
    "auth.login",
    "auth.logout",
    "permissions.get",
    "permissions.set",
    "sandbox.status",
    "sandbox.set",
    "hooks.get",
    "hooks.set",
    "hooks.pending",
    "hooks.respond",
    "tasks.list",
    "tasks.get",
    "tasks.create",
    "tasks.update",
    "tasks.stop",
    "tasks.capabilities",
    "todos.get",
    "todos.write",
    "teams.capabilities",
    "workflows.capabilities",
    "teams.list",
    "teams.get",
    "workflows.list",
    "workflows.get",
    "schedules.list",
    "schedules.get",
    "schedules.create",
    "schedules.update",
    "schedules.delete",
    "schedules.run",
    "schedules.history",
    "schedules.subscribe",
    "channels.list",
    "channels.configure",
    "channels.status",
    "channels.login",
    "channels.pair",
    "channels.login.cancel",
    "channels.stop",
    "channels.logout",
    "channels.delete",
    "sessions.create",
    "sessions.list",
    "sessions.subscribeCatalog",
    "sessions.get",
    "sessions.rename",
    "sessions.delete",
    "sessions.retire",
    "sessions.close",
    "sessions.resume",
    "sessions.fork",
    "sessions.setModel",
    "sessions.setMode",
    "sessions.setProactive",
    "sessions.native",
    "runs.submit",
    "runs.list",
    "runs.get",
    "runs.cancel",
    "approvals.list",
    "approvals.respond",
    "questions.list",
    "questions.respond",
    "events.replay",
    "events.subscribe",
    "diagnostics.query",
    "usage.get",
    "usage.list",
    "usage.recent",
    "usage.sessionTimeseries",
    "usage.limits",
    "retention.status",
    "retention.prune",
    "tools.list",
    "tools.get",
];

pub(super) fn capabilities() -> Value {
    json!({
        "protocolVersion": super::PROTOCOL_VERSION,
        "serverVersion": env!("CARGO_PKG_VERSION"),
        "methods": METHODS,
        "notifications": ["session.event", "sessions.catalogChanged", "events.subscriptionError", "schedules.receipt", "schedules.subscriptionError"],
        "transport": {
            "jsonRpc": "2.0",
            "batch": true,
            "concurrentRequests": true,
            "disconnectCancelsRuns": false,
            "events": { "durableReplay": true, "cursor": "sessionId/seq", "delivery": "replayable_not_exactly_once" },
        },
        "availability": "Methods are wired; CLI, platform, authentication and configured-resource conditions are checked by their owners",
    })
}

pub(super) async fn dispatch(gateway: &Gateway, method: &str, params: Value) -> rpc::Result {
    if !METHODS.contains(&method) {
        return Err(rpc::Error::method(method));
    }
    let config = gateway.config.as_ref();
    let sessions = &gateway.sessions;
    match method.split_once('.').map(|(family, _)| family) {
        Some("server")
            if method == "server.capabilities"
                && params.as_object().is_some_and(|params| params.is_empty()) =>
        {
            Ok(capabilities())
        }
        Some("server") if method == "server.capabilities" => Err(rpc::Error::invalid(
            "server.capabilities requires an empty object",
        )),
        Some("config") => config::dispatch(method, params, config).await,
        Some("search") => search::dispatch(method, params, config, sessions).await,
        Some("agents") => agent::dispatch(method, params, config, sessions).await,
        Some("workspace") => workspace::dispatch(method, params, config).await,
        Some("memory") => memory::dispatch(method, params, config).await,
        Some("prompts" | "instructions") => {
            prompt::dispatch(method, params, config, sessions).await
        }
        Some("skills") => skill::dispatch(method, params, config).await,
        Some("sealedSkills") => sealed::dispatch(config, method, params).await,
        Some("plugins") => plugin::dispatch(method, params, config, sessions).await,
        Some("mcp") => mcp::dispatch(method, params, config, sessions).await,
        Some("providers" | "models" | "auth") => {
            provider::dispatch(method, params, config, sessions).await
        }
        Some("hooks") if matches!(method, "hooks.pending" | "hooks.respond") => {
            gateway
                .interactions
                .dispatch(method, params, sessions)
                .await
        }
        Some("permissions" | "sandbox" | "hooks") => {
            policy::dispatch(method, params, config, sessions).await
        }
        Some("tools") => tool::dispatch(method, params, config, sessions).await,
        Some("tasks" | "todos") => task::dispatch(method, params, config, sessions, &gateway.diagnostics).await,
        Some("teams") => team::dispatch(method, params, config, sessions).await,
        Some("workflows") => workflow::dispatch(method, params, config, sessions).await,
        Some("schedules") => schedule::dispatch(method, params, config, sessions).await,
        Some("channels") => channel::dispatch(method, params, config, sessions).await,
        Some("sessions" | "runs") => sessions.dispatch(method, params).await,
        Some("approvals" | "questions") => {
            gateway
                .interactions
                .dispatch(method, params, sessions)
                .await
        }
        Some("diagnostics") => gateway.diagnostics.dispatch(method, params).await,
        Some("usage") => usage::dispatch(method, params, config, sessions, &gateway.events).await,
        Some("retention") => {
            retention::dispatch(method, params, config, &gateway.diagnostics).await
        }
        _ => Err(rpc::Error::method(method)),
    }
}
