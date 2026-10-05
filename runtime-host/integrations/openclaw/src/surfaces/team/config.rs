use organization::{
    MaterializationReceipt, RoleMaterializationOwnership, TeamId, TeamMaterializationRequest,
};
use platform::state_dir::CanonicalStateDir;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use zeroize::Zeroizing;

use crate::gateway::wire::team::ConfigRestoreFacts;

const MAX_UNDO_BYTES: usize = 4 * 1024 * 1024;

/// Private recovery evidence, not a second Team command ledger.
pub(super) struct ConfigUndo {
    record: UndoRecord,
}

#[derive(Serialize, Deserialize)]
struct UndoRecord {
    team: String,
    endpoint: String,
    request_key: String,
    roles: Vec<UndoRole>,
    state: UndoState,
}

#[derive(Serialize, Deserialize)]
struct UndoRole {
    role: String,
    agent: String,
    workspace: String,
    managed: bool,
    agents_markdown: Option<String>,
}

#[derive(Serialize, Deserialize)]
#[serde(tag = "status", content = "facts")]
enum UndoState {
    Active(serde_json::Value),
    Removed,
    Compensated,
}

impl ConfigUndo {
    pub(super) fn prepare(
        request: &TeamMaterializationRequest,
        receipt: &MaterializationReceipt,
        facts: &ConfigRestoreFacts,
    ) -> Result<Self, ()> {
        Ok(Self {
            record: UndoRecord {
                team: request.intent().team().as_str().to_owned(),
                endpoint: request.intent().endpoint().as_str().to_owned(),
                request_key: request.idempotency_key().as_str().to_owned(),
                roles: receipt
                    .roles()
                    .iter()
                    .map(|role| {
                        Ok(UndoRole {
                            role: role.role().as_str().to_owned(),
                            agent: role.agent().as_str().to_owned(),
                            workspace: role.native_workspace().ok_or(())?.as_str().to_owned(),
                            managed: role.ownership() == RoleMaterializationOwnership::Managed,
                            agents_markdown: role.agents_markdown().map(str::to_owned),
                        })
                    })
                    .collect::<Result<_, ()>>()?,
                state: UndoState::Active(facts.to_private_value().map_err(|_| ())?),
            },
        })
    }

    pub(super) fn load(state_dir: &CanonicalStateDir, team: &TeamId) -> Result<Option<Self>, ()> {
        let Some(bytes) = state_dir
            .read_regular_file_bounded(&file_name(team.as_str()), MAX_UNDO_BYTES)
            .map_err(|_| ())?
        else {
            return Ok(None);
        };
        let bytes = Zeroizing::new(bytes);
        let record: UndoRecord = serde_json::from_slice(&bytes).map_err(|_| ())?;
        if record.team != team.as_str() {
            return Err(());
        }
        Ok(Some(Self { record }))
    }

    pub(super) fn persist(&self, state_dir: &CanonicalStateDir) -> Result<(), ()> {
        let bytes = Zeroizing::new(serde_json::to_vec(&self.record).map_err(|_| ())?);
        state_dir
            .replace_regular_file_bounded(&file_name(&self.record.team), &bytes, MAX_UNDO_BYTES)
            .map_err(|_| ())
    }

    pub(super) fn facts(&self) -> Result<ConfigRestoreFacts, ()> {
        let UndoState::Active(facts) = &self.record.state else {
            return Err(());
        };
        ConfigRestoreFacts::from_private_value(facts.clone()).map_err(|_| ())
    }

    pub(super) fn matches_request(&self, request: &TeamMaterializationRequest) -> bool {
        self.record.team == request.intent().team().as_str()
            && self.record.endpoint == request.intent().endpoint().as_str()
            && self.record.request_key == request.idempotency_key().as_str()
            && self.record.roles.len() == request.intent().agents().len()
            && request.intent().agents().iter().all(|requested| {
                self.record.roles.iter().any(|role| {
                    role.role == requested.role().as_str()
                        && role.agents_markdown.as_deref() == requested.agents_markdown()
                        && match requested.agent() {
                            organization::RoleMaterializationAgent::Managed { .. } => role.managed,
                            organization::RoleMaterializationAgent::External { agent } => {
                                !role.managed && role.agent == agent.as_str()
                            }
                        }
                })
            })
    }

    pub(super) fn matches_receipt(&self, receipt: &MaterializationReceipt) -> bool {
        self.receipt().is_ok_and(|stored| stored == *receipt)
    }

    pub(super) fn receipt(&self) -> Result<MaterializationReceipt, ()> {
        let endpoint = organization::RuntimeEndpointReference::try_new(&self.record.endpoint)
            .map_err(|_| ())?;
        let roles = self
            .record
            .roles
            .iter()
            .map(|role| {
                let receipt = organization::RoleMaterializationReceipt::with_native_workspace(
                    organization::RoleId::try_new(&role.role).map_err(|_| ())?,
                    organization::ManagedAgentReference::try_new(&role.agent).map_err(|_| ())?,
                    if role.managed {
                        RoleMaterializationOwnership::Managed
                    } else {
                        RoleMaterializationOwnership::External
                    },
                    endpoint.clone(),
                    organization::NativeWorkspaceReceipt::try_new(&role.workspace)
                        .map_err(|_| ())?,
                );
                Ok(match &role.agents_markdown {
                    Some(markdown) => receipt.with_agents_markdown(markdown.clone()),
                    None => receipt,
                })
            })
            .collect::<Result<_, ()>>()?;
        MaterializationReceipt::try_new(
            TeamId::try_new(&self.record.team).map_err(|_| ())?,
            endpoint,
            roles,
        )
        .map_err(|_| ())
    }

    pub(super) fn has_external_roles(&self) -> bool {
        self.record.roles.iter().any(|role| !role.managed)
    }

    pub(super) fn is_removed(&self) -> bool {
        matches!(self.record.state, UndoState::Removed)
    }

    pub(super) fn is_compensated(&self) -> bool {
        matches!(self.record.state, UndoState::Compensated)
    }

    pub(super) fn finish_removal(mut self, state_dir: &CanonicalStateDir) -> Result<(), ()> {
        self.record.state = UndoState::Removed;
        self.persist(state_dir)
    }

    pub(super) fn finish_compensation(mut self, state_dir: &CanonicalStateDir) -> Result<(), ()> {
        self.record.state = UndoState::Compensated;
        self.persist(state_dir)
    }
}

fn file_name(team: &str) -> String {
    format!(
        "team-config-undo-{:x}.json",
        Sha256::digest(team.as_bytes())
    )
}
