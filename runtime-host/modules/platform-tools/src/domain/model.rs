use platform::call::CallDetail;
use serde::Serialize;

#[derive(Clone, Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PlatformToolsCallDetail {
    pub tool_count: Option<usize>,
    pub available: Option<bool>,
    pub result: Option<PlatformToolsCallResult>,
}

impl CallDetail for PlatformToolsCallDetail {
    const MODULE: &'static str = "platform-tools";
}

#[derive(Clone, Copy, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum PlatformToolsCallResult {
    Tools,
    Unavailable,
    Rejected,
}

impl PlatformToolsOutcome {
    pub(crate) fn call_detail(&self) -> PlatformToolsCallDetail {
        match self {
            Self::Tools(tools) => PlatformToolsCallDetail {
                tool_count: Some(tools.len()),
                available: Some(true),
                result: Some(PlatformToolsCallResult::Tools),
            },
            Self::Unavailable => PlatformToolsCallDetail {
                tool_count: None,
                available: Some(false),
                result: Some(PlatformToolsCallResult::Unavailable),
            },
        }
    }
}

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
