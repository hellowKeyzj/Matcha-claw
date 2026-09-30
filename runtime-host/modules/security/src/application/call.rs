use platform::call::{CallContext, CallDetail, CallStatus};
use serde::Serialize;

#[derive(Clone, Serialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub(crate) enum SecurityCallDetail {
    PolicyRead,
    PolicyReplace {
        correlation: String,
        revision: Option<u64>,
        effect: Option<Effect>,
    },
    Emergency {
        correlation: String,
        outcome: Option<EmergencyEffect>,
    },
    Audit {
        page: u64,
        #[serde(rename = "pageSize")]
        page_size: u64,
        total: Option<u64>,
        outcome: Option<Effect>,
    },
    Operation {
        correlation: String,
        operation: SecurityOperation,
        outcome: Option<Effect>,
    },
    OperationReceipt { correlation: String },
    RuleCatalog,
}

impl CallDetail for SecurityCallDetail {
    const MODULE: &'static str = "security";
}

#[derive(Clone, Copy, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) enum SecurityOperation {
    QuickAudit,
    CheckIntegrity,
    RebaselineIntegrity,
    ScanSkills,
    CheckAdvisories,
    PreviewRemediation,
    ApplyRemediation,
    RollbackRemediation,
}

impl SecurityOperation {
    pub(crate) fn parse(method: &str) -> Option<Self> {
        Some(match method {
            "security.quickAudit" => Self::QuickAudit,
            "security.checkIntegrity" => Self::CheckIntegrity,
            "security.rebaselineIntegrity" => Self::RebaselineIntegrity,
            "security.scanSkills" => Self::ScanSkills,
            "security.checkAdvisories" => Self::CheckAdvisories,
            "security.previewRemediation" => Self::PreviewRemediation,
            "security.applyRemediation" => Self::ApplyRemediation,
            "security.rollbackRemediation" => Self::RollbackRemediation,
            _ => return None,
        })
    }

    pub(crate) const fn command(self) -> &'static str {
        match self {
            Self::QuickAudit => "security.quickAudit",
            Self::CheckIntegrity => "security.checkIntegrity",
            Self::RebaselineIntegrity => "security.rebaselineIntegrity",
            Self::ScanSkills => "security.scanSkills",
            Self::CheckAdvisories => "security.checkAdvisories",
            Self::PreviewRemediation => "security.previewRemediation",
            Self::ApplyRemediation => "security.applyRemediation",
            Self::RollbackRemediation => "security.rollbackRemediation",
        }
    }
}

#[derive(Clone, Copy, Serialize)]
#[serde(rename_all = "lowercase")]
pub(crate) enum Effect {
    Confirmed,
    Rejected,
    Unavailable,
    Unknown,
}

impl Effect {
    pub(crate) const fn status(self) -> CallStatus {
        match self {
            Self::Confirmed => CallStatus::Succeeded,
            Self::Rejected => CallStatus::Rejected,
            Self::Unavailable => CallStatus::Failed,
            Self::Unknown => CallStatus::Unknown,
        }
    }
}

#[derive(Clone, Copy, Serialize)]
#[serde(rename_all = "snake_case")]
pub(crate) enum EmergencyEffect {
    Applied,
    TargetRejected,
    OutcomeUnknown,
    Unavailable,
}

impl EmergencyEffect {
    pub(crate) const fn effect(self) -> Effect {
        match self {
            Self::Applied => Effect::Confirmed,
            Self::TargetRejected => Effect::Rejected,
            Self::OutcomeUnknown => Effect::Unknown,
            Self::Unavailable => Effect::Unavailable,
        }
    }
}

pub(crate) struct SecurityCall {
    pub context: CallContext<SecurityCallDetail>,
    pub detail: SecurityCallDetail,
}

impl SecurityCall {
    pub(crate) async fn running(&self) -> Result<(), ()> {
        self.context.running().await.map_err(|_| ())
    }

    pub(crate) async fn finish(&self, detail: &SecurityCallDetail, effect: Effect) {
        if let Err(error) = self.context.finish(effect.status(), detail).await {
            eprintln!("security call {} settlement failed: {error}", self.context.id().as_str());
        }
    }
}
