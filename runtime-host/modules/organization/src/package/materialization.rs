use std::collections::BTreeMap;
use std::fmt;

use crate::{
    IdempotencyKey, ManagedAgentReference, MaterializationOperationOutcome, MaterializationReceipt,
    RoleId, RuntimeEndpointReference, TeamId, TeamMaterialization, TeamMaterializationError,
    TeamMaterializationRequest,
};

use super::{TeamSkillPackage, TeamSkillSelectionId};
use crate::team::{
    compile_manual_team_materialization as compile_manual_team,
    compile_team_skill_materialization as compile_team_skill,
};

/// Closed Organization facts produced after a TeamSkill selection has been read and validated.
///
/// The package root and package documents are deliberately absent. A Host adapter may consume the
/// request and definition, but cannot recover the private source from these facts.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct TeamSkillMaterializationFacts {
    selection_id: TeamSkillSelectionId,
    package_name: String,
    package_version: String,
    materialization: TeamMaterialization,
}

impl TeamSkillMaterializationFacts {
    pub(super) fn compile(
        selection_id: TeamSkillSelectionId,
        package: &TeamSkillPackage,
        team_id: TeamId,
        endpoint: RuntimeEndpointReference,
        idempotency_key: IdempotencyKey,
    ) -> Result<Self, TeamMaterializationError> {
        let materialization = compile_team_skill(package, team_id, endpoint, idempotency_key)
            .map_err(|_| TeamMaterializationError::Invalid)?;
        Ok(Self {
            selection_id,
            package_name: package.name().to_owned(),
            package_version: package.version().to_owned(),
            materialization,
        })
    }

    pub fn selection_id(&self) -> &TeamSkillSelectionId {
        &self.selection_id
    }

    pub fn package_name(&self) -> &str {
        &self.package_name
    }

    pub fn package_version(&self) -> &str {
        &self.package_version
    }

    pub fn team(&self) -> &TeamMaterialization {
        &self.materialization
    }

    pub fn request(&self) -> &TeamMaterializationRequest {
        self.materialization.request()
    }
}

/// One explicitly selected native agent for a Manual Team role.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ManualTeamRoleSelection {
    role: RoleId,
    member_name: String,
    agent: ManagedAgentReference,
    leader: bool,
}

impl ManualTeamRoleSelection {
    pub fn try_new(
        role: RoleId,
        member_name: impl Into<String>,
        agent: ManagedAgentReference,
        leader: bool,
    ) -> Result<Self, InvalidManualTeamRoleSelection> {
        let member_name = member_name.into();
        if member_name.trim().is_empty() {
            return Err(InvalidManualTeamRoleSelection::BlankMemberName);
        }
        if leader != (role.as_str() == "leader") {
            return Err(InvalidManualTeamRoleSelection::LeaderRoleMismatch);
        }
        Ok(Self {
            role,
            member_name,
            agent,
            leader,
        })
    }

    pub fn role(&self) -> &RoleId {
        &self.role
    }

    pub fn member_name(&self) -> &str {
        &self.member_name
    }

    pub fn agent(&self) -> &ManagedAgentReference {
        &self.agent
    }

    pub const fn is_leader(&self) -> bool {
        self.leader
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum InvalidManualTeamRoleSelection {
    BlankMemberName,
    LeaderRoleMismatch,
}

impl fmt::Display for InvalidManualTeamRoleSelection {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(match self {
            Self::BlankMemberName => "manual Team role member name is required",
            Self::LeaderRoleMismatch => "manual Team leader role must be exactly the leader role",
        })
    }
}

impl std::error::Error for InvalidManualTeamRoleSelection {}

/// Closed facts produced from explicitly selected existing agents.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ManualTeamMaterializationFacts {
    materialization: TeamMaterialization,
}

impl ManualTeamMaterializationFacts {
    pub fn compile(
        team_id: TeamId,
        team_name: impl Into<String>,
        endpoint: RuntimeEndpointReference,
        roles: Vec<ManualTeamRoleSelection>,
        idempotency_key: IdempotencyKey,
    ) -> Result<Self, TeamMaterializationError> {
        if roles.is_empty() || roles.iter().filter(|role| role.is_leader()).count() != 1 {
            return Err(TeamMaterializationError::Invalid);
        }
        let bindings = roles
            .into_iter()
            .map(|role| {
                crate::ManualTeamRoleBinding::try_new(
                    role.role,
                    role.member_name,
                    role.agent,
                    role.leader,
                )
                .map_err(|_| TeamMaterializationError::Invalid)
            })
            .collect::<Result<Vec<_>, _>>()?;
        let materialization =
            compile_manual_team(team_id, team_name, endpoint, bindings, idempotency_key)?;
        Ok(Self { materialization })
    }

    pub fn team(&self) -> &TeamMaterialization {
        &self.materialization
    }

    pub fn request(&self) -> &TeamMaterializationRequest {
        self.materialization.request()
    }
}

/// The package owner can produce either a TeamSkill or Manual closed materialization.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum TeamMaterializationFacts {
    TeamSkill(TeamSkillMaterializationFacts),
    Manual(ManualTeamMaterializationFacts),
}

impl TeamMaterializationFacts {
    pub fn request(&self) -> &TeamMaterializationRequest {
        match self {
            Self::TeamSkill(facts) => facts.request(),
            Self::Manual(facts) => facts.request(),
        }
    }

    pub fn team(&self) -> &TeamMaterialization {
        match self {
            Self::TeamSkill(facts) => facts.team(),
            Self::Manual(facts) => facts.team(),
        }
    }
}

/// The result of submitting a durable materialization request to the package-owned replay ledger.
/// `DispatchNative` is returned only for the first request. A replay of a retained request never
/// carries a native request and therefore cannot accidentally repeat the provider effect.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum TeamMaterializationDispatch {
    DispatchNative { request: TeamMaterializationRequest },
    ReplayedRequested,
    ReplayedConfirmed { receipt: MaterializationReceipt },
    ReplayedRejected,
    ReplayedOutcomeUnknown,
}

#[derive(Clone, Debug, Eq, PartialEq)]
enum TeamMaterializationState {
    Requested {
        request: TeamMaterializationRequest,
    },
    Confirmed {
        request: TeamMaterializationRequest,
        receipt: MaterializationReceipt,
    },
    Rejected {
        request: TeamMaterializationRequest,
    },
    OutcomeUnknown {
        request: TeamMaterializationRequest,
    },
}

impl TeamMaterializationState {
    fn request(&self) -> &TeamMaterializationRequest {
        match self {
            Self::Requested { request }
            | Self::Confirmed { request, .. }
            | Self::Rejected { request }
            | Self::OutcomeUnknown { request } => request,
        }
    }
}

/// In-memory owner oracle for request replay and startup recovery.
///
/// Durable Organization storage remains responsible for persisting the request and provider
/// outcome. This type intentionally has no native-effect callback: `recover` can only return
/// receipt/observation facts and can never dispatch the request again.
#[derive(Clone, Debug, Default, Eq, PartialEq)]
pub struct TeamMaterializationLedger {
    requests: BTreeMap<String, TeamMaterializationState>,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum TeamMaterializationLedgerError {
    ConflictingRequest,
    UnknownRequest,
    ConflictingOutcome,
    ReceiptMismatch,
}

impl fmt::Display for TeamMaterializationLedgerError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(match self {
            Self::ConflictingRequest => "idempotency key is bound to another materialization",
            Self::UnknownRequest => "materialization request is unknown",
            Self::ConflictingOutcome => "materialization outcome conflicts with its terminal state",
            Self::ReceiptMismatch => "materialization receipt does not match its request",
        })
    }
}

impl std::error::Error for TeamMaterializationLedgerError {}

impl TeamMaterializationLedger {
    /// Records a request and returns a native dispatch only on first observation of its key.
    pub fn request(
        &mut self,
        request: TeamMaterializationRequest,
    ) -> Result<TeamMaterializationDispatch, TeamMaterializationLedgerError> {
        let key = request.idempotency_key().as_str().to_owned();
        let Some(existing) = self.requests.get(&key) else {
            self.requests.insert(
                key,
                TeamMaterializationState::Requested {
                    request: request.clone(),
                },
            );
            return Ok(TeamMaterializationDispatch::DispatchNative { request });
        };
        if existing.request() != &request {
            return Err(TeamMaterializationLedgerError::ConflictingRequest);
        }
        Ok(match existing {
            TeamMaterializationState::Requested { .. } => {
                TeamMaterializationDispatch::ReplayedRequested
            }
            TeamMaterializationState::Confirmed { receipt, .. } => {
                TeamMaterializationDispatch::ReplayedConfirmed {
                    receipt: receipt.clone(),
                }
            }
            TeamMaterializationState::Rejected { .. } => {
                TeamMaterializationDispatch::ReplayedRejected
            }
            TeamMaterializationState::OutcomeUnknown { .. } => {
                TeamMaterializationDispatch::ReplayedOutcomeUnknown
            }
        })
    }

    /// Records the provider outcome without ever invoking a provider itself.
    pub fn record_outcome(
        &mut self,
        idempotency_key: &IdempotencyKey,
        outcome: MaterializationOperationOutcome,
    ) -> Result<(), TeamMaterializationLedgerError> {
        let Some(state) = self.requests.get_mut(idempotency_key.as_str()) else {
            return Err(TeamMaterializationLedgerError::UnknownRequest);
        };
        let request = state.request().clone();
        match (state.clone(), outcome) {
            (
                TeamMaterializationState::Requested { .. }
                | TeamMaterializationState::OutcomeUnknown { .. },
                MaterializationOperationOutcome::Confirmed { receipt },
            ) => {
                if receipt.team() != request.intent().team()
                    || receipt.endpoint() != request.intent().endpoint()
                {
                    return Err(TeamMaterializationLedgerError::ReceiptMismatch);
                }
                *state = TeamMaterializationState::Confirmed { request, receipt };
                Ok(())
            }
            (
                TeamMaterializationState::Requested { .. }
                | TeamMaterializationState::OutcomeUnknown { .. },
                MaterializationOperationOutcome::Rejected { .. },
            ) => {
                *state = TeamMaterializationState::Rejected { request };
                Ok(())
            }
            (
                TeamMaterializationState::Requested { .. }
                | TeamMaterializationState::OutcomeUnknown { .. },
                MaterializationOperationOutcome::Accepted { .. }
                | MaterializationOperationOutcome::OutcomeUnknown,
            ) => {
                *state = TeamMaterializationState::OutcomeUnknown { request };
                Ok(())
            }
            (
                TeamMaterializationState::Confirmed {
                    receipt: previous, ..
                },
                MaterializationOperationOutcome::Confirmed { receipt },
            ) if previous == receipt => Ok(()),
            (
                TeamMaterializationState::Rejected { .. },
                MaterializationOperationOutcome::Rejected { .. },
            ) => Ok(()),
            _ => Err(TeamMaterializationLedgerError::ConflictingOutcome),
        }
    }

    pub fn recover(&self, idempotency_key: &IdempotencyKey) -> TeamMaterializationRecovery {
        let Some(state) = self.requests.get(idempotency_key.as_str()) else {
            return TeamMaterializationRecovery::Unavailable;
        };
        match state {
            TeamMaterializationState::Confirmed { receipt, .. } => {
                TeamMaterializationRecovery::Confirmed {
                    receipt: receipt.clone(),
                }
            }
            TeamMaterializationState::Requested { request }
            | TeamMaterializationState::OutcomeUnknown { request } => {
                TeamMaterializationRecovery::ObserveOnly {
                    team: request.intent().team().clone(),
                    endpoint: request.intent().endpoint().clone(),
                    idempotency_key: request.idempotency_key().clone(),
                }
            }
            TeamMaterializationState::Rejected { .. } => TeamMaterializationRecovery::Rejected,
        }
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum TeamMaterializationRecovery {
    Confirmed {
        receipt: MaterializationReceipt,
    },
    /// The provider effect may have happened. Recovery must observe/reconcile externally and must
    /// not dispatch the original native request again.
    ObserveOnly {
        team: TeamId,
        endpoint: RuntimeEndpointReference,
        idempotency_key: IdempotencyKey,
    },
    Rejected,
    Unavailable,
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{
        Dependency, DependencyKind, MaterializationSource, PackageRole, TeamSkillPackageInput,
        ports::RoleMaterializationAgent,
    };

    fn endpoint() -> RuntimeEndpointReference {
        RuntimeEndpointReference::try_new("endpoint:openclaw").unwrap()
    }

    fn team_id(value: &str) -> TeamId {
        TeamId::try_new(value).unwrap()
    }

    fn key(value: &str) -> IdempotencyKey {
        IdempotencyKey::try_new(value).unwrap()
    }

    fn package() -> TeamSkillPackage {
        TeamSkillPackage::try_new(TeamSkillPackageInput {
            name: "Research".to_owned(),
            version: "1.0.0".to_owned(),
            description: "Research team".to_owned(),
            skill_markdown: "private".to_owned(),
            workflow_markdown: "private".to_owned(),
            bind_markdown: None,
            roles: vec![
                PackageRole::try_new("researcher", "Research facts", vec![], vec![], "private")
                    .unwrap(),
                PackageRole::try_new("reviewer", "Review facts", vec![], vec![], "private")
                    .unwrap(),
            ],
            dependencies: vec![
                Dependency::try_new(DependencyKind::Skill, "web", true, "Search", None).unwrap(),
            ],
        })
        .unwrap()
    }

    fn skill_facts() -> TeamSkillMaterializationFacts {
        TeamSkillMaterializationFacts::compile(
            TeamSkillSelectionId::parse(format!("teamskill:v1:{}", "a".repeat(64))).unwrap(),
            &package(),
            team_id("team:research"),
            endpoint(),
            key("materialize:research"),
        )
        .unwrap()
    }

    #[test]
    fn teamskill_facts_close_a_managed_leader_and_every_package_role() {
        let facts = skill_facts();
        let agents = facts.request().intent().agents();
        assert_eq!(agents.len(), 3);
        assert!(matches!(
            agents[0].agent(),
            RoleMaterializationAgent::Managed { name } if name == "leader"
        ));
        assert!(matches!(
            agents[1].agent(),
            RoleMaterializationAgent::Managed { name } if name == "researcher"
        ));
        assert!(matches!(
            agents[2].agent(),
            RoleMaterializationAgent::Managed { name } if name == "reviewer"
        ));
        assert!(!format!("{facts:?}").contains("private-workspace"));
    }

    #[test]
    fn manual_facts_require_one_leader_and_unique_role_agents() {
        let leader = ManualTeamRoleSelection::try_new(
            crate::RoleId::try_new("leader").unwrap(),
            "Lead",
            ManagedAgentReference::try_new("agent:lead").unwrap(),
            true,
        )
        .unwrap();
        let reviewer = ManualTeamRoleSelection::try_new(
            crate::RoleId::try_new("reviewer").unwrap(),
            "Reviewer",
            ManagedAgentReference::try_new("agent:reviewer").unwrap(),
            false,
        )
        .unwrap();
        let facts = ManualTeamMaterializationFacts::compile(
            team_id("team:manual"),
            "Manual",
            endpoint(),
            vec![leader.clone(), reviewer.clone()],
            key("materialize:manual"),
        )
        .unwrap();
        assert_eq!(facts.request().intent().agents().len(), 2);
        assert_eq!(
            facts.request().intent().source(),
            MaterializationSource::Manual
        );
        assert!(matches!(
            facts.request().intent().agents()[0].agent(),
            RoleMaterializationAgent::External { agent } if agent.as_str() == "agent:lead"
        ));
        assert_eq!(
            ManualTeamMaterializationFacts::compile(
                team_id("team:manual"),
                "Manual",
                endpoint(),
                vec![
                    leader,
                    ManualTeamRoleSelection::try_new(
                        crate::RoleId::try_new("reviewer").unwrap(),
                        "Reviewer",
                        ManagedAgentReference::try_new("agent:lead").unwrap(),
                        false,
                    )
                    .unwrap(),
                ],
                key("materialize:manual:duplicate"),
            ),
            Err(TeamMaterializationError::Invalid)
        );
    }

    #[test]
    fn replayed_request_never_returns_a_second_native_effect() {
        let facts = skill_facts();
        let request = facts.request().clone();
        let mut ledger = TeamMaterializationLedger::default();
        assert!(matches!(
            ledger.request(request.clone()).unwrap(),
            TeamMaterializationDispatch::DispatchNative { .. }
        ));
        assert_eq!(
            ledger.request(request.clone()).unwrap(),
            TeamMaterializationDispatch::ReplayedRequested
        );
        assert!(matches!(
            ledger.recover(request.idempotency_key()),
            TeamMaterializationRecovery::ObserveOnly { .. }
        ));
    }

    #[test]
    fn recovery_returns_receipt_facts_without_reissuing_native_effect() {
        let facts = skill_facts();
        let request = facts.request().clone();
        let receipt = crate::MaterializationReceipt::try_new(
            team_id("team:research"),
            endpoint(),
            request
                .intent()
                .agents()
                .iter()
                .map(|agent| {
                    let native =
                        crate::ManagedAgentReference::try_new(agent.role().as_str()).unwrap();
                    crate::RoleMaterializationReceipt::new(agent.role().clone(), native, endpoint())
                })
                .collect(),
        )
        .unwrap();
        let mut ledger = TeamMaterializationLedger::default();
        ledger.request(request.clone()).unwrap();
        ledger
            .record_outcome(
                request.idempotency_key(),
                MaterializationOperationOutcome::Confirmed {
                    receipt: receipt.clone(),
                },
            )
            .unwrap();
        assert_eq!(
            ledger.recover(request.idempotency_key()),
            TeamMaterializationRecovery::Confirmed { receipt }
        );
        assert!(matches!(
            ledger.request(request).unwrap(),
            TeamMaterializationDispatch::ReplayedConfirmed { .. }
        ));
    }
}
