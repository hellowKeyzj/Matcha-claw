const CORE_SOURCE: &str = "core";

pub(crate) fn platform_tools_catalog(
    result: Result<
        crate::native_config::agent_configuration::ToolCatalog,
        crate::native_config::agent_configuration::ReadFailure,
    >,
) -> platform_tools::PlatformToolsOutcome {
    match result {
        Ok(catalog) => platform_tools::PlatformToolsOutcome::Tools(
            catalog.options().iter().filter_map(platform_tool).collect(),
        ),
        Err(
            crate::native_config::agent_configuration::ReadFailure::Rejected
            | crate::native_config::agent_configuration::ReadFailure::Unavailable
            | crate::native_config::agent_configuration::ReadFailure::Protocol,
        ) => platform_tools::PlatformToolsOutcome::Unavailable,
    }
}

fn platform_tool(
    option: &crate::native_config::agent_configuration::ToolOption,
) -> Option<platform_tools::PlatformTool> {
    option.group_key()?;
    Some(platform_tools::PlatformTool::new(
        option.key().to_owned(),
        option.display_name().to_owned(),
        if option.source() == CORE_SOURCE {
            "native".to_owned()
        } else {
            option.source().to_owned()
        },
        true,
        option.description().map(str::to_owned),
        None,
    ))
}
