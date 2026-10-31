use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CallToolResult {
    pub content: Vec<ContentBlock>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub structured_content: Option<Map<String, Value>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub is_error: Option<bool>,
    #[serde(rename = "_meta", skip_serializing_if = "Option::is_none")]
    pub meta: Option<Map<String, Value>>,
}

impl CallToolResult {
    pub fn error(text: String) -> Self {
        Self {
            content: vec![ContentBlock::text(text)],
            structured_content: None,
            is_error: Some(true),
            meta: None,
        }
    }

    pub(super) fn json(result: Value, is_error: bool) -> Self {
        Self {
            content: vec![ContentBlock::text(
                serde_json::to_string(&result).expect("JSON tool DTO is serializable"),
            )],
            structured_content: None,
            is_error: is_error.then_some(true),
            meta: None,
        }
    }
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum ContentBlock {
    Text {
        text: String,
        #[serde(flatten)]
        attributes: Map<String, Value>,
    },
    Image {
        data: String,
        #[serde(rename = "mimeType")]
        mime_type: String,
        #[serde(flatten)]
        attributes: Map<String, Value>,
    },
    Audio {
        data: String,
        #[serde(rename = "mimeType")]
        mime_type: String,
        #[serde(flatten)]
        attributes: Map<String, Value>,
    },
    Resource {
        resource: ResourceContents,
        #[serde(flatten)]
        attributes: Map<String, Value>,
    },
    ResourceLink {
        #[serde(flatten)]
        resource: super::Resource,
    },
}

impl ContentBlock {
    pub fn text(text: String) -> Self {
        Self::Text {
            text,
            attributes: Map::new(),
        }
    }
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ResourceContents {
    pub uri: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub mime_type: Option<String>,
    #[serde(flatten)]
    pub body: ResourceBody,
    #[serde(rename = "_meta", skip_serializing_if = "Option::is_none")]
    pub meta: Option<Map<String, Value>>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(untagged)]
pub enum ResourceBody {
    Text { text: String },
    Blob { blob: String },
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct ReadResourceResult {
    pub contents: Vec<ResourceContents>,
    #[serde(rename = "_meta", skip_serializing_if = "Option::is_none")]
    pub meta: Option<Map<String, Value>>,
}
