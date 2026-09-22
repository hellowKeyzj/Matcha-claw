use serde::Serialize;

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum PlatformToolsOutcome {
    Tools(Vec<PlatformTool>),
    Unavailable,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PlatformTool {
    id: String,
    name: String,
    source: String,
    enabled: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    description: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    version: Option<String>,
}

impl PlatformTool {
    pub fn new(
        id: String,
        name: String,
        source: String,
        enabled: bool,
        description: Option<String>,
        version: Option<String>,
    ) -> Self {
        Self {
            id,
            name,
            source,
            enabled,
            description,
            version,
        }
    }
}
