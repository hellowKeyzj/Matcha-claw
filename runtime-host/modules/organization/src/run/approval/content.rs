use std::collections::BTreeSet;
use std::fmt;

use serde::{Deserialize, Serialize};

#[derive(Clone, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ApprovalContent {
    pub title: String,
    pub body: Option<String>,
    pub artifact_ids: Vec<String>,
}

impl ApprovalContent {
    pub(crate) fn is_valid(&self) -> bool {
        !self.title.trim().is_empty()
            && self.body.as_deref().is_none_or(valid_body)
            && valid_artifact_ids(&self.artifact_ids)
    }
}

#[derive(Clone, Eq, PartialEq, Serialize, Deserialize)]
#[serde(try_from = "Submission")]
pub struct ApprovalSubmission {
    body: String,
    risk: Option<String>,
    artifact_ids: Vec<String>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Submission {
    body: String,
    risk: Option<String>,
    artifact_ids: Vec<String>,
}

impl TryFrom<Submission> for ApprovalSubmission {
    type Error = &'static str;

    fn try_from(value: Submission) -> Result<Self, Self::Error> {
        Self::try_new(value.body, value.risk, value.artifact_ids).ok_or("invalid approval request")
    }
}

impl ApprovalSubmission {
    pub fn try_new(body: String, risk: Option<String>, artifact_ids: Vec<String>) -> Option<Self> {
        (valid_body(&body)
            && risk.as_deref().is_none_or(|value| !value.trim().is_empty())
            && valid_artifact_ids(&artifact_ids))
        .then_some(Self { body, risk, artifact_ids })
    }

    pub fn body(&self) -> &str { &self.body }
    pub fn risk(&self) -> Option<&str> { self.risk.as_deref() }
    pub fn artifact_ids(&self) -> &[String] { &self.artifact_ids }
}

fn valid_body(value: &str) -> bool {
    !value.trim().is_empty()
}

fn valid_artifact_ids(ids: &[String]) -> bool {
    let mut seen = BTreeSet::new();
    ids.iter().all(|id| !id.trim().is_empty() && id.len() <= 128 && seen.insert(id))
}

impl fmt::Debug for ApprovalContent {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.debug_struct("ApprovalContent")
            .field("has_body", &self.body.is_some())
            .field("artifact_count", &self.artifact_ids.len())
            .finish_non_exhaustive()
    }
}

impl fmt::Debug for ApprovalSubmission {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.debug_struct("ApprovalSubmission")
            .field("has_risk", &self.risk.is_some())
            .field("artifact_count", &self.artifact_ids.len())
            .finish_non_exhaustive()
    }
}
