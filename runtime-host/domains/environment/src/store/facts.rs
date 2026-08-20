use crate::definition::{DesiredDefinition, EnvironmentId, EnvironmentRevision};

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct AppliedEvidence {
    revision: EnvironmentRevision,
}

impl AppliedEvidence {
    pub const fn new(revision: EnvironmentRevision) -> Self {
        Self { revision }
    }

    pub const fn revision(&self) -> EnvironmentRevision {
        self.revision
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct EnvironmentFacts {
    desired: DesiredDefinition,
    tombstone: bool,
    applied: Option<AppliedEvidence>,
}

impl EnvironmentFacts {
    pub const fn new(desired: DesiredDefinition, applied: Option<AppliedEvidence>) -> Self {
        Self {
            desired,
            tombstone: false,
            applied,
        }
    }

    pub const fn tombstone(desired: DesiredDefinition) -> Self {
        Self {
            desired,
            tombstone: true,
            applied: None,
        }
    }

    pub const fn desired(&self) -> &DesiredDefinition {
        &self.desired
    }

    pub const fn applied(&self) -> Option<&AppliedEvidence> {
        self.applied.as_ref()
    }

    pub const fn is_tombstone(&self) -> bool {
        self.tombstone
    }

    pub fn environment_id(&self) -> &EnvironmentId {
        self.desired.environment_id()
    }

    pub fn desired_revision(&self) -> EnvironmentRevision {
        self.desired.revision()
    }

    pub fn has_current_applied_evidence(&self) -> bool {
        !self.tombstone
            && matches!(self.applied, Some(evidence) if evidence.revision == self.desired.revision())
    }
}

#[cfg(test)]
mod tests {
    use crate::definition::{
        BrowserMode, DesiredConfiguration, DesiredDefinition, EnvironmentId, EnvironmentRevision,
        ProviderReference, SecurityPreset,
    };

    use super::{AppliedEvidence, EnvironmentFacts};

    #[test]
    fn matching_applied_revision_is_current_apply_evidence_not_convergence() {
        let desired = DesiredDefinition::new(
            EnvironmentId::try_new("environment:primary").unwrap(),
            EnvironmentRevision::try_new(7).unwrap(),
            ProviderReference::try_new("anthropic").unwrap(),
            DesiredConfiguration::try_new(
                Vec::new(),
                Vec::new(),
                Vec::new(),
                Vec::new(),
                Vec::new(),
                Vec::new(),
                SecurityPreset::Relaxed,
                BrowserMode::Relay,
                Vec::new(),
            )
            .unwrap(),
        );
        let facts = EnvironmentFacts::new(
            desired,
            Some(AppliedEvidence::new(
                EnvironmentRevision::try_new(7).unwrap(),
            )),
        );

        assert!(facts.has_current_applied_evidence());
    }

    #[test]
    fn tombstone_has_no_applied_convergence_evidence() {
        let desired = DesiredDefinition::new(
            EnvironmentId::try_new("environment:primary").unwrap(),
            EnvironmentRevision::try_new(7).unwrap(),
            ProviderReference::try_new("anthropic").unwrap(),
            DesiredConfiguration::try_new(
                Vec::new(),
                Vec::new(),
                Vec::new(),
                Vec::new(),
                Vec::new(),
                Vec::new(),
                SecurityPreset::Relaxed,
                BrowserMode::Relay,
                Vec::new(),
            )
            .unwrap(),
        );
        let facts = EnvironmentFacts::tombstone(desired);

        assert!(facts.is_tombstone());
        assert!(facts.applied().is_none());
        assert!(!facts.has_current_applied_evidence());
    }
}
