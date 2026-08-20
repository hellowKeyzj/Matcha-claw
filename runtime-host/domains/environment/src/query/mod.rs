use std::fmt;

use crate::{
    definition::{EnvironmentId, EnvironmentRevision},
    store::EnvironmentFacts,
};

pub const MAX_ENVIRONMENT_PAGE_SIZE: usize = 100;

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum EnvironmentQuery {
    Get(EnvironmentId),
    List(ListEnvironments),
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ListEnvironments {
    after: Option<EnvironmentId>,
    page_size: EnvironmentPageSize,
}

impl ListEnvironments {
    pub fn new(after: Option<EnvironmentId>, page_size: EnvironmentPageSize) -> Self {
        Self { after, page_size }
    }

    pub fn after(&self) -> Option<&EnvironmentId> {
        self.after.as_ref()
    }

    pub const fn page_size(&self) -> EnvironmentPageSize {
        self.page_size
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct EnvironmentPageSize(usize);

impl EnvironmentPageSize {
    pub fn try_new(value: usize) -> Result<Self, InvalidEnvironmentPageSize> {
        if value == 0 {
            return Err(InvalidEnvironmentPageSize::Zero);
        }
        if value > MAX_ENVIRONMENT_PAGE_SIZE {
            return Err(InvalidEnvironmentPageSize::ExceedsMaximum);
        }
        Ok(Self(value))
    }

    pub const fn get(self) -> usize {
        self.0
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum InvalidEnvironmentPageSize {
    Zero,
    ExceedsMaximum,
}

impl fmt::Display for InvalidEnvironmentPageSize {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Zero => formatter.write_str("environment page size must be greater than zero"),
            Self::ExceedsMaximum => {
                formatter.write_str("environment page size exceeds the maximum")
            }
        }
    }
}

impl std::error::Error for InvalidEnvironmentPageSize {}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum AppliedEvidenceState {
    NotRecorded,
    Current,
    DifferentRevision(EnvironmentRevision),
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct EnvironmentProjection {
    environment_id: EnvironmentId,
    desired_revision: EnvironmentRevision,
    applied_evidence: AppliedEvidenceState,
}

impl EnvironmentProjection {
    pub fn from_facts(facts: &EnvironmentFacts) -> Self {
        let desired_revision = facts.desired_revision();
        let applied_evidence = match facts.applied() {
            None => AppliedEvidenceState::NotRecorded,
            Some(evidence) if evidence.revision() == desired_revision => {
                AppliedEvidenceState::Current
            }
            Some(evidence) => AppliedEvidenceState::DifferentRevision(evidence.revision()),
        };

        Self {
            environment_id: facts.environment_id().clone(),
            desired_revision,
            applied_evidence,
        }
    }

    pub fn environment_id(&self) -> &EnvironmentId {
        &self.environment_id
    }

    pub const fn desired_revision(&self) -> EnvironmentRevision {
        self.desired_revision
    }

    pub const fn applied_evidence(&self) -> AppliedEvidenceState {
        self.applied_evidence
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct EnvironmentListPage {
    environments: Vec<EnvironmentProjection>,
    next_after: Option<EnvironmentId>,
}

impl EnvironmentListPage {
    pub fn try_new(
        environments: Vec<EnvironmentProjection>,
        after: Option<&EnvironmentId>,
        next_after: Option<EnvironmentId>,
        page_size: EnvironmentPageSize,
    ) -> Result<Self, InvalidEnvironmentListPage> {
        if environments.len() > page_size.get() {
            return Err(InvalidEnvironmentListPage::ExceedsPageSize);
        }
        if environments
            .windows(2)
            .any(|pair| pair[0].environment_id().as_str() >= pair[1].environment_id().as_str())
        {
            return Err(InvalidEnvironmentListPage::UnstableOrder);
        }
        if let Some(after) = after
            && environments
                .first()
                .map(EnvironmentProjection::environment_id)
                .is_some_and(|environment_id| environment_id.as_str() <= after.as_str())
        {
            return Err(InvalidEnvironmentListPage::CursorMustAdvance);
        }
        if let Some(next_after) = &next_after
            && environments
                .last()
                .map(EnvironmentProjection::environment_id)
                != Some(next_after)
        {
            return Err(InvalidEnvironmentListPage::CursorMustMatchLastEnvironment);
        }

        Ok(Self {
            environments,
            next_after,
        })
    }

    pub fn environments(&self) -> &[EnvironmentProjection] {
        &self.environments
    }

    pub fn next_after(&self) -> Option<&EnvironmentId> {
        self.next_after.as_ref()
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum InvalidEnvironmentListPage {
    ExceedsPageSize,
    UnstableOrder,
    CursorMustAdvance,
    CursorMustMatchLastEnvironment,
}

impl fmt::Display for InvalidEnvironmentListPage {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::ExceedsPageSize => {
                formatter.write_str("environment list page exceeds its requested size")
            }
            Self::UnstableOrder => {
                formatter.write_str("environment list page must be ordered by environment identity")
            }
            Self::CursorMustAdvance => {
                formatter.write_str("environment list page must start after its requested cursor")
            }
            Self::CursorMustMatchLastEnvironment => {
                formatter.write_str("environment list page cursor must match its last environment")
            }
        }
    }
}

impl std::error::Error for InvalidEnvironmentListPage {}

#[cfg(test)]
mod tests {
    use crate::{
        definition::{
            BrowserMode, ChannelReference, ConnectorReference, CredentialReference,
            DesiredConfiguration, DesiredDefinition, ExtensionReference, PolicyReference,
            ProviderReference, SecurityPreset, ToolchainReference,
        },
        store::{AppliedEvidence, EnvironmentFacts},
    };

    use super::*;

    fn facts(desired_revision: u64, applied_revision: Option<u64>) -> EnvironmentFacts {
        EnvironmentFacts::new(
            DesiredDefinition::new(
                EnvironmentId::try_new("environment:primary").unwrap(),
                EnvironmentRevision::try_new(desired_revision).unwrap(),
                ProviderReference::try_new("provider:anthropic").unwrap(),
                DesiredConfiguration::try_new(
                    vec![ConnectorReference::try_new("connector:calendar").unwrap()],
                    vec![ExtensionReference::try_new("extension:browser").unwrap()],
                    vec![ChannelReference::try_new("channel:discord").unwrap()],
                    vec![CredentialReference::try_new("credential:v1:private-canary").unwrap()],
                    vec![PolicyReference::try_new("policy:balanced").unwrap()],
                    vec![ToolchainReference::try_new("toolchain:bun").unwrap()],
                    SecurityPreset::Relaxed,
                    BrowserMode::Relay,
                    Vec::new(),
                )
                .unwrap(),
            ),
            applied_revision.map(|revision| {
                AppliedEvidence::new(EnvironmentRevision::try_new(revision).unwrap())
            }),
        )
    }

    fn projection(environment_id: &str, revision: u64) -> EnvironmentProjection {
        EnvironmentProjection::from_facts(&EnvironmentFacts::new(
            DesiredDefinition::new(
                EnvironmentId::try_new(environment_id).unwrap(),
                EnvironmentRevision::try_new(revision).unwrap(),
                ProviderReference::try_new("provider:anthropic").unwrap(),
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
            ),
            None,
        ))
    }

    #[test]
    fn list_query_requires_a_bounded_positive_page_size() {
        assert_eq!(
            EnvironmentPageSize::try_new(0),
            Err(InvalidEnvironmentPageSize::Zero)
        );
        assert_eq!(
            EnvironmentPageSize::try_new(MAX_ENVIRONMENT_PAGE_SIZE + 1),
            Err(InvalidEnvironmentPageSize::ExceedsMaximum)
        );
        assert_eq!(
            EnvironmentPageSize::try_new(MAX_ENVIRONMENT_PAGE_SIZE)
                .unwrap()
                .get(),
            MAX_ENVIRONMENT_PAGE_SIZE
        );
    }

    #[test]
    fn projection_keeps_desired_and_applied_evidence_distinct_without_definitions() {
        let current = EnvironmentProjection::from_facts(&facts(7, Some(7)));
        let different = EnvironmentProjection::from_facts(&facts(7, Some(6)));
        let absent = EnvironmentProjection::from_facts(&facts(7, None));

        assert_eq!(current.environment_id().as_str(), "environment:primary");
        assert_eq!(current.desired_revision().get(), 7);
        assert_eq!(current.applied_evidence(), AppliedEvidenceState::Current);
        assert_eq!(
            different.applied_evidence(),
            AppliedEvidenceState::DifferentRevision(EnvironmentRevision::try_new(6).unwrap())
        );
        assert_eq!(absent.applied_evidence(), AppliedEvidenceState::NotRecorded);

        let rendered = format!("{current:?}{different:?}{absent:?}");
        for reference in [
            "provider:anthropic",
            "connector:calendar",
            "extension:browser",
            "channel:discord",
            "credential:v1:private-canary",
            "policy:balanced",
            "toolchain:bun",
        ] {
            assert!(!rendered.contains(reference));
        }
    }

    #[test]
    fn list_page_oracle_preserves_stable_order_bounded_results_and_cursor() {
        let page_size = EnvironmentPageSize::try_new(2).unwrap();
        let first = projection("environment:design", 1);
        let second = projection("environment:research", 3);
        let page = EnvironmentListPage::try_new(
            vec![first, second],
            None,
            Some(EnvironmentId::try_new("environment:research").unwrap()),
            page_size,
        )
        .unwrap();

        assert_eq!(page.environments().len(), 2);
        assert_eq!(page.environments()[1].desired_revision().get(), 3);
        assert_eq!(page.next_after().unwrap().as_str(), "environment:research");
    }

    #[test]
    fn list_page_oracle_rejects_unstable_unbounded_or_invalid_cursors() {
        let page_size = EnvironmentPageSize::try_new(1).unwrap();
        let after = EnvironmentId::try_new("environment:design").unwrap();
        let unstable = EnvironmentListPage::try_new(
            vec![
                projection("environment:research", 1),
                projection("environment:design", 1),
            ],
            None,
            None,
            EnvironmentPageSize::try_new(2).unwrap(),
        );
        let unbounded = EnvironmentListPage::try_new(
            vec![
                projection("environment:design", 1),
                projection("environment:research", 1),
            ],
            None,
            None,
            page_size,
        );
        let repeated_cursor = EnvironmentListPage::try_new(
            vec![projection("environment:design", 1)],
            Some(&after),
            None,
            page_size,
        );
        let invalid_next_after = EnvironmentListPage::try_new(
            vec![projection("environment:design", 1)],
            None,
            Some(EnvironmentId::try_new("environment:research").unwrap()),
            page_size,
        );

        assert_eq!(unstable, Err(InvalidEnvironmentListPage::UnstableOrder));
        assert_eq!(unbounded, Err(InvalidEnvironmentListPage::ExceedsPageSize));
        assert_eq!(
            repeated_cursor,
            Err(InvalidEnvironmentListPage::CursorMustAdvance)
        );
        assert_eq!(
            invalid_next_after,
            Err(InvalidEnvironmentListPage::CursorMustMatchLastEnvironment)
        );
    }
}
