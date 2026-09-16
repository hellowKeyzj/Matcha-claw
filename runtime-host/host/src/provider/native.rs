use openclaw::port::{
    AppliedStatus, ObservedStatus, ProviderNativeConfigurationDiagnostic,
    ProviderNativeConfigurationEffect,
};

#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) struct ProviderNativeConfigurationView {
    pub(crate) changed: bool,
    pub(crate) applied: &'static str,
    pub(crate) observed: &'static str,
    pub(crate) diagnostic: Option<ProviderNativeConfigurationDiagnosticView>,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) struct ProviderNativeConfigurationDiagnosticView {
    pub(crate) phase: String,
    pub(crate) reason: String,
    pub(crate) config_path: String,
    pub(crate) method: Option<String>,
    pub(crate) expected_path: Option<String>,
    pub(crate) detail: Option<String>,
}

impl ProviderNativeConfigurationView {
    pub(crate) fn unavailable() -> Self {
        Self {
            changed: false,
            applied: "unknown",
            observed: "unavailable",
            diagnostic: None,
        }
    }

    pub(crate) fn from_effect(effect: &ProviderNativeConfigurationEffect) -> Self {
        match effect {
            ProviderNativeConfigurationEffect::Evidence(evidence) => Self {
                changed: evidence.changed(),
                applied: applied_status(evidence.applied()),
                observed: observed_status(evidence.observed()),
                diagnostic: evidence
                    .diagnostic()
                    .map(ProviderNativeConfigurationDiagnosticView::from_diagnostic),
            },
            ProviderNativeConfigurationEffect::Unavailable => Self::unavailable(),
        }
    }
}

impl ProviderNativeConfigurationDiagnosticView {
    fn from_diagnostic(diagnostic: &ProviderNativeConfigurationDiagnostic) -> Self {
        Self {
            phase: diagnostic.phase().to_owned(),
            reason: diagnostic.reason().to_owned(),
            config_path: diagnostic.config_path().to_owned(),
            method: diagnostic.method().map(str::to_owned),
            expected_path: diagnostic.expected_path().map(str::to_owned),
            detail: diagnostic.detail().map(str::to_owned),
        }
    }
}

const fn applied_status(status: AppliedStatus) -> &'static str {
    match status {
        AppliedStatus::Confirmed => "confirmed",
        AppliedStatus::Unknown => "unknown",
    }
}

const fn observed_status(status: ObservedStatus) -> &'static str {
    match status {
        ObservedStatus::Matches => "matches",
        ObservedStatus::Mismatch => "mismatch",
        ObservedStatus::Unavailable => "unavailable",
    }
}
