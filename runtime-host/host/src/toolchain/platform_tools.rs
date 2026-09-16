use serde::Serialize;

const CORE_SOURCE: &str = "core";

#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) enum Outcome {
    Tools(Vec<Tool>),
    Unavailable,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Tool {
    id: String,
    name: String,
    source: String,
    enabled: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    description: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    version: Option<String>,
}

pub(crate) fn catalog(
    result: Result<
        openclaw::projection::agent_configuration::ToolCatalog,
        openclaw::projection::agent_configuration::ReadFailure,
    >,
) -> Outcome {
    match result {
        Ok(catalog) => Outcome::Tools(catalog.options().iter().filter_map(tool).collect()),
        Err(
            openclaw::projection::agent_configuration::ReadFailure::Rejected
            | openclaw::projection::agent_configuration::ReadFailure::Unavailable
            | openclaw::projection::agent_configuration::ReadFailure::Protocol,
        ) => Outcome::Unavailable,
    }
}

fn tool(option: &openclaw::projection::agent_configuration::ToolOption) -> Option<Tool> {
    option.group_key()?;
    Some(Tool {
        id: option.key().to_owned(),
        name: option.display_name().to_owned(),
        source: if option.source() == CORE_SOURCE {
            "native".to_owned()
        } else {
            option.source().to_owned()
        },
        enabled: true,
        description: option.description().map(str::to_owned),
        version: None,
    })
}

pub(crate) mod delivery {
    use serde_json::Value;

    use super::Outcome;

    pub(crate) enum Delivery {
        Ok(Vec<super::Tool>),
        Unavailable,
    }

    impl Delivery {
        pub(crate) fn status_code(&self) -> u16 {
            match self {
                Self::Ok(_) => 200,
                Self::Unavailable => 503,
            }
        }

        pub(crate) fn body(&self) -> Value {
            match self {
                Self::Ok(tools) => serde_json::json!({ "success": true, "tools": tools }),
                Self::Unavailable => serde_json::json!({
                    "success": false,
                    "error": "Platform tools catalog is unavailable",
                }),
            }
        }
    }

    impl From<Outcome> for Delivery {
        fn from(value: Outcome) -> Self {
            match value {
                Outcome::Tools(tools) => Self::Ok(tools),
                Outcome::Unavailable => Self::Unavailable,
            }
        }
    }
}
