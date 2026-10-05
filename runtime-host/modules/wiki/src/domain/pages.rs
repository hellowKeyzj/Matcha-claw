use serde::{Deserialize, Serialize};

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WikiNavigationPage {
    pub path: String,
    pub title: String,
    #[serde(rename = "type")]
    pub kind: String,
    pub tags: Vec<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub origin: Option<String>,
    pub sources: Vec<String>,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WikiNavigation {
    pub project_id: String,
    pub pages: Vec<WikiNavigationPage>,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct WikiDeletePageInput {
    pub project_id: Option<String>,
    pub path: String,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum WikiDeletePageStage {
    File,
    Vector,
    Media,
    References,
    Snapshot,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WikiDeletePageFailure {
    pub stage: WikiDeletePageStage,
    pub path: String,
    pub message: String,
}

#[derive(Clone, Debug, Default, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WikiDeletePageReceipt {
    pub project_id: String,
    pub path: String,
    pub deleted_pages: Vec<String>,
    pub updated_pages: Vec<String>,
    pub deleted_media: Vec<String>,
    pub failures: Vec<WikiDeletePageFailure>,
}
