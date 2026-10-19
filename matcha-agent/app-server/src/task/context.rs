use crate::{
    cli::projection::{env_name, provider_sources},
    config::Config,
    rpc::{self, Error},
};

use super::files::Context;

// Resolve only native non-secret task context; execution projection may require credentials.
pub(super) fn initial(config: &Config, session_id: &str) -> rpc::Result<Context> {
    let source_names = provider_sources(config)?;
    let value = |target: &str| -> rpc::Result<Option<String>> {
        let reference = config
            .cli
            .env
            .iter()
            .find(|(name, _)| env_name((*name).clone()) == target);
        let Some((_, source)) = reference else {
            if source_names.contains(target)
                || config
                    .cli
                    .env
                    .values()
                    .any(|source| env_name(source.clone()) == target)
                || config
                    .auth_token_env
                    .as_ref()
                    .is_some_and(|source| env_name(source.clone()) == target)
                || config.private_provider_env.source(target).is_some()
                || config.private_mcp_env.source(target).is_some()
            {
                return Ok(None);
            }
            return std::env::var(target)
                .map(Some)
                .or_else(|error| match error {
                    std::env::VarError::NotPresent => Ok(None),
                    _ => Err(Error::unavailable(
                        "native_environment_encoding",
                        "The native task environment is not Unicode",
                    )),
                });
        };
        if source_names.contains(&env_name(source.clone()))
            || config.private_provider_env.source(source).is_some()
            || config.private_mcp_env.source(source).is_some()
            || config
                .auth_token_env
                .as_ref()
                .is_some_and(|token| env_name(token.clone()) == env_name(source.clone()))
        {
            return Err(Error::invalid(
                "Native task context cannot reference private credential sources",
            ));
        }
        match std::env::var(source) {
            Ok(value) if !value.is_empty() => Ok(Some(value)),
            Ok(_) => Err(Error::unavailable(
                "native_env_source_empty",
                "A native task environment source is empty",
            )),
            Err(std::env::VarError::NotPresent) => Err(Error::unavailable(
                "native_env_source_missing",
                "A native task environment source is not set",
            )),
            Err(_) => Err(Error::unavailable(
                "native_env_source_encoding",
                "A native task environment source is not Unicode",
            )),
        }
    };
    let mut team_name = None;
    let mut args = config.cli.args.iter();
    while let Some(arg) = args.next() {
        if arg == "--team-name" {
            team_name = Some(
                args.next()
                    .ok_or_else(|| Error::invalid("--team-name requires a value"))?
                    .as_str(),
            );
        } else if let Some(name) = arg.strip_prefix("--team-name=") {
            team_name = Some(name);
        }
    }
    let explicit = value("CLAUDE_CODE_TASK_LIST_ID")?;
    let list_id = explicit
        .as_deref()
        .filter(|id| !id.is_empty())
        .or(team_name.filter(|name| !name.is_empty()))
        .unwrap_or(session_id);
    let todo_v2 = value("CLAUDE_CODE_ENABLE_TASKS")?.is_some_and(|value| {
        matches!(
            value.trim().to_ascii_lowercase().as_str(),
            "1" | "true" | "yes" | "on"
        )
    });
    Ok(Context {
        list_id: super::sanitize(list_id),
        todo_v2,
    })
}
