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
    #[serde(default)]
    config_not_written: bool,
    #[serde(default)]
    compensation: Option<Compensation>,
    #[serde(default)]
    request_signature: Option<String>,
    #[serde(default)]
    provisioning: bool,
    #[serde(default)]
    retryable_rejection: bool,
    #[serde(default)]
    removal: Option<Vec<CompensationAgent>>,
}

#[derive(Serialize, Deserialize)]
pub(super) struct Compensation {
    pub(super) config_applied: bool,
    pub(super) effects_known: bool,
    pub(super) config: ConfigCompensation,
    pub(super) agents: Vec<CompensationAgent>,
}

#[derive(Clone, Copy, Eq, PartialEq, Serialize, Deserialize)]
pub(super) enum ConfigCompensation {
    Pending,
    InFlight,
    Restored,
}

#[derive(Serialize, Deserialize)]
pub(super) struct CompensationAgent {
    pub(super) agent: String,
    pub(super) state: CompensationState,
    #[serde(default)]
    pub(super) delete_acknowledged: bool,
}

#[derive(Clone, Copy, Eq, PartialEq, Serialize, Deserialize)]
pub(super) enum CompensationState {
    Pending,
    InFlight,
    Deleted,
}

#[derive(Serialize, Deserialize)]
struct UndoRole {
    role: String,
    agent: String,
    workspace: String,
    managed: bool,
    agents_markdown: Option<String>,
    #[serde(default)]
    name: Option<String>,
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
                            name: None,
                        })
                    })
                    .collect::<Result<_, ()>>()?,
                state: UndoState::Active(facts.to_private_value().map_err(|_| ())?),
                config_not_written: true,
                compensation: None,
                request_signature: Some(request_signature(request)),
                provisioning: false,
                retryable_rejection: false,
                removal: None,
            },
        })
    }

    pub(super) fn provisioning(request: &TeamMaterializationRequest) -> Self {
        Self {
            record: UndoRecord {
                team: request.intent().team().as_str().to_owned(),
                endpoint: request.intent().endpoint().as_str().to_owned(),
                request_key: request.idempotency_key().as_str().to_owned(),
                roles: Vec::new(),
                state: UndoState::Active(serde_json::json!([])),
                config_not_written: true,
                compensation: None,
                request_signature: Some(request_signature(request)),
                provisioning: true,
                retryable_rejection: false,
                removal: None,
            },
        }
    }

    pub(super) fn is_provisioning(&self) -> bool {
        self.record.provisioning
    }

    pub(super) fn record_created(
        &mut self,
        state_dir: &CanonicalStateDir,
        role: &organization::RoleAgentMaterialization,
        agent: &super::agent::TeamOwnedAgentId,
        workspace: &super::workspace::ResolvedWorkspace,
    ) -> Result<(), ()> {
        let organization::RoleMaterializationAgent::Managed { name } = role.agent() else {
            return Err(());
        };
        if !self.record.provisioning || self.record.roles.iter().any(|stored| {
            stored.role == role.role().as_str() || stored.agent == agent.as_str()
        }) {
            return Err(());
        }
        self.record.roles.push(UndoRole {
            role: role.role().as_str().to_owned(),
            agent: agent.as_str().to_owned(),
            workspace: workspace.as_str().to_owned(),
            managed: true,
            agents_markdown: role.agents_markdown().map(str::to_owned),
            name: Some(name.clone()),
        });
        self.provisioning_effects(state_dir, true)
    }

    pub(super) fn provisioning_effects(
        &mut self,
        state_dir: &CanonicalStateDir,
        effects_known: bool,
    ) -> Result<(), ()> {
        if !self.record.provisioning {
            return Err(());
        }
        let agents = self.record.roles.iter().map(|role| CompensationAgent {
            agent: role.agent.clone(),
            state: CompensationState::Pending,
            delete_acknowledged: false,
        }).collect();
        let previous_effects_known = self.record.compensation.as_ref()
            .is_none_or(|compensation| compensation.effects_known);
        self.record.compensation = Some(Compensation {
            config_applied: false,
            effects_known,
            config: ConfigCompensation::Restored,
            agents,
        });
        if self.persist(state_dir).is_err() {
            if !effects_known {
                self.record.compensation.as_mut().expect("prepared compensation")
                    .effects_known = previous_effects_known;
            }
            return Err(());
        }
        Ok(())
    }

    pub(super) fn capture_created_config(
        &mut self,
        state_dir: &CanonicalStateDir,
        snapshot: &crate::gateway::wire::team::ConfigSnapshot,
    ) -> Result<(), ()> {
        if !self.record.provisioning {
            return Err(());
        }
        let UndoState::Active(facts) = &mut self.record.state else {
            return Err(());
        };
        let entries = facts.as_array_mut().ok_or(())?;
        let missing = self.record.roles.iter().filter(|role| {
            !entries.iter().any(|fact| {
                fact.get("agent_id").and_then(serde_json::Value::as_str) == Some(role.agent.as_str())
            })
        }).map(|role| {
            Ok((role.agent.as_str(), role.name.as_deref().ok_or(())?, role.workspace.as_str()))
        }).collect::<Result<Vec<_>, ()>>()?;
        if !missing.is_empty() {
            let observed = snapshot.created_agent_facts(&missing).map_err(|_| ())?
                .to_private_value().map_err(|_| ())?;
            entries.extend(observed.as_array().ok_or(())?.iter().cloned());
            self.persist(state_dir)?;
        }
        self.facts().map(|_| ())
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
        let entries = facts.as_array().ok_or(())?;
        if entries.len() != self.record.roles.len()
            || self.record.roles.iter().any(|role| {
                entries.iter().filter(|fact| {
                    fact.get("agent_id").and_then(serde_json::Value::as_str)
                        == Some(role.agent.as_str())
                        && fact.get("external").and_then(serde_json::Value::as_bool)
                            == Some(!role.managed)
                }).count() != 1
            })
        {
            return Err(());
        }
        ConfigRestoreFacts::from_private_value(facts.clone()).map_err(|_| ())
    }

    pub(super) fn matches_request(&self, request: &TeamMaterializationRequest) -> bool {
        if self.record.provisioning {
            return self.record.team == request.intent().team().as_str()
                && self.record.endpoint == request.intent().endpoint().as_str()
                && self.record.request_key == request.idempotency_key().as_str()
                && self.record.request_signature.as_deref() == Some(request_signature(request).as_str())
                && self.record.roles.iter().all(|role| {
                    role.managed && request.intent().agents().iter().any(|requested| {
                        requested.role().as_str() == role.role
                            && requested.agents_markdown() == role.agents_markdown.as_deref()
                            && matches!(requested.agent(), organization::RoleMaterializationAgent::Managed { name }
                                if Some(name.as_str()) == role.name.as_deref())
                    })
                });
        }
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

    pub(super) fn config_may_have_reached(&mut self, state_dir: &CanonicalStateDir) -> Result<(), ()> {
        self.record.config_not_written = false;
        if self.persist(state_dir).is_err() {
            self.record.config_not_written = true;
            return Err(());
        }
        Ok(())
    }

    pub(super) fn config_rejected(&mut self, state_dir: &CanonicalStateDir, retryable: bool) -> Result<(), ()> {
        self.record.config_not_written = true;
        self.record.retryable_rejection = retryable;
        self.persist(state_dir)
    }

    pub(super) fn config_not_written(&self) -> bool {
        self.record.config_not_written
    }

    pub(super) fn record_retryable_rejection(&mut self, state_dir: &CanonicalStateDir) -> Result<(), ()> {
        self.record.retryable_rejection = true;
        self.persist(state_dir)
    }

    pub(super) fn rejection(&self) -> organization::MaterializationRejection {
        if self.record.retryable_rejection {
            organization::MaterializationRejection::Retryable
        } else {
            organization::MaterializationRejection::Permanent
        }
    }

    pub(super) fn for_removal(receipt: &MaterializationReceipt) -> Result<Self, ()> {
        if receipt.roles().iter().any(|role| role.ownership() != RoleMaterializationOwnership::Managed) {
            return Err(());
        }
        Ok(Self {
            record: UndoRecord {
                team: receipt.team().as_str().to_owned(),
                endpoint: receipt.endpoint().as_str().to_owned(),
                request_key: String::new(),
                roles: receipt.roles().iter().map(|role| {
                    Ok(UndoRole {
                        role: role.role().as_str().to_owned(),
                        agent: role.agent().as_str().to_owned(),
                        workspace: role.native_workspace().ok_or(())?.as_str().to_owned(),
                        managed: true,
                        agents_markdown: role.agents_markdown().map(str::to_owned),
                        name: None,
                    })
                }).collect::<Result<_, ()>>()?,
                state: UndoState::Active(serde_json::json!([])),
                config_not_written: true,
                compensation: None,
                request_signature: None,
                provisioning: false,
                retryable_rejection: false,
                removal: None,
            },
        })
    }

    pub(super) fn begin_removal(&mut self, state_dir: &CanonicalStateDir) -> Result<(), ()> {
        if self.record.compensation.is_some() || self.is_removed() || self.is_compensated() {
            return Err(());
        }
        if self.record.removal.is_none() {
            self.record.removal = Some(self.record.roles.iter()
                .filter(|role| role.managed)
                .map(|role| CompensationAgent {
                    agent: role.agent.clone(), state: CompensationState::Pending,
                    delete_acknowledged: false,
                }).collect());
        }
        self.persist(state_dir)
    }

    pub(super) fn is_removing(&self) -> bool {
        self.record.removal.is_some()
    }

    pub(super) fn removal_completed(&self) -> bool {
        let Some(resources) = &self.record.removal else {
            return false;
        };
        let mut managed = self.record.roles.iter().filter(|role| role.managed);
        resources.len() == managed.clone().count() && managed.all(|role| {
            resources.iter().filter(|resource| resource.agent == role.agent
                && resource.state == CompensationState::Deleted && resource.delete_acknowledged).count() == 1
        })
    }

    pub(super) fn removal_agent(&self, agent: &str) -> Option<CompensationState> {
        self.record.removal.as_ref()?.iter()
            .find(|resource| resource.agent == agent
                && (resource.state != CompensationState::Deleted || resource.delete_acknowledged))
            .map(|resource| resource.state)
    }

    pub(super) fn record_removal_agent(
        &mut self, state_dir: &CanonicalStateDir, agent: &str, state: CompensationState,
    ) -> Result<(), ()> {
        let resource = self.record.removal.as_mut().ok_or(())?.iter_mut()
            .find(|resource| resource.agent == agent).ok_or(())?;
        resource.state = state;
        resource.delete_acknowledged = state == CompensationState::Deleted;
        self.persist(state_dir)
    }

    pub(super) fn begin_compensation(
        &mut self,
        state_dir: &CanonicalStateDir,
        created_agents: &[super::agent::TeamOwnedAgentId],
        effects_known: bool,
    ) -> Result<(), ()> {
        if self.record.compensation.is_none() {
            self.record.compensation = Some(Compensation {
                config_applied: !self.record.config_not_written,
                effects_known,
                config: if self.record.config_not_written || !self.has_external_roles() {
                    ConfigCompensation::Restored
                } else {
                    ConfigCompensation::Pending
                },
                agents: created_agents
                    .iter()
                    .map(|agent| CompensationAgent {
                        agent: agent.as_str().to_owned(),
                        state: CompensationState::Pending,
                        delete_acknowledged: false,
                    })
                    .collect(),
            });
        }
        self.persist(state_dir)
    }

    pub(super) fn compensation(&self) -> Option<&Compensation> {
        self.record.compensation.as_ref()
    }

    pub(super) fn compensation_completed(&self) -> bool {
        let Some(compensation) = self.compensation() else {
            return false;
        };
        let mut managed = self.record.roles.iter().filter(|role| role.managed);
        compensation.effects_known && compensation.config == ConfigCompensation::Restored
            && compensation.agents.len() == managed.clone().count()
            && managed.all(|role| compensation.agents.iter().filter(|resource| {
                resource.agent == role.agent && resource.state == CompensationState::Deleted
                    && resource.delete_acknowledged
            }).count() == 1)
    }

    pub(super) fn record_config_compensation(
        &mut self,
        state_dir: &CanonicalStateDir,
        state: ConfigCompensation,
    ) -> Result<(), ()> {
        self.record.compensation.as_mut().ok_or(())?.config = state;
        self.persist(state_dir)
    }

    pub(super) fn record_compensation_agent(
        &mut self,
        state_dir: &CanonicalStateDir,
        agent: &str,
        state: CompensationState,
    ) -> Result<(), ()> {
        let compensation = self.record.compensation.as_mut().ok_or(())?;
        let resource = compensation
            .agents
            .iter_mut()
            .find(|resource| resource.agent == agent)
            .ok_or(())?;
        resource.state = state;
        resource.delete_acknowledged = state == CompensationState::Deleted;
        self.persist(state_dir)
    }

    pub(super) fn matches_receipt(&self, receipt: &MaterializationReceipt) -> bool {
        self.receipt().is_ok_and(|stored| stored == *receipt)
    }

    pub(super) fn team(&self) -> Result<TeamId, ()> {
        TeamId::try_new(&self.record.team).map_err(|_| ())
    }

    pub(super) fn roles(&self) -> Result<Vec<organization::RoleMaterializationReceipt>, ()> {
        let mut roles = std::collections::BTreeSet::new();
        let mut agents = std::collections::BTreeSet::new();
        if self.record.roles.iter().any(|role| {
            !roles.insert(role.role.as_str()) || !agents.insert(role.agent.as_str())
        }) {
            return Err(());
        }
        let endpoint = organization::RuntimeEndpointReference::try_new(&self.record.endpoint)
            .map_err(|_| ())?;
        self
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
            .collect::<Result<_, ()>>()
    }

    pub(super) fn receipt(&self) -> Result<MaterializationReceipt, ()> {
        if self.record.provisioning {
            return Err(());
        }
        MaterializationReceipt::try_new(
            TeamId::try_new(&self.record.team).map_err(|_| ())?,
            organization::RuntimeEndpointReference::try_new(&self.record.endpoint).map_err(|_| ())?,
            self.roles()?,
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
        if !self.removal_completed() && !self.compensation_completed() {
            return Err(());
        }
        self.record.state = UndoState::Removed;
        self.persist(state_dir)
    }

    pub(super) fn finish_compensation(&mut self, state_dir: &CanonicalStateDir) -> Result<(), ()> {
        if !self.compensation_completed() {
            return Err(());
        }
        let state = std::mem::replace(&mut self.record.state, UndoState::Compensated);
        if self.persist(state_dir).is_err() {
            self.record.state = state;
            return Err(());
        }
        Ok(())
    }
}

fn request_signature(request: &TeamMaterializationRequest) -> String {
    let agents = request.intent().agents().iter().map(|role| {
        let agent = match role.agent() {
            organization::RoleMaterializationAgent::Managed { name } => serde_json::json!({"managed": name}),
            organization::RoleMaterializationAgent::External { agent } => serde_json::json!({"external": agent.as_str()}),
        };
        serde_json::json!({
            "role": role.role().as_str(), "agent": agent,
            "tools": role.tools(), "agents_markdown": role.agents_markdown(),
        })
    }).collect::<Vec<_>>();
    let signature = serde_json::json!({
        "source": match request.intent().source() {
            organization::MaterializationSource::Manual => "manual",
            organization::MaterializationSource::TeamSkill => "team-skill",
        },
        "agents": agents,
    });
    format!("{:x}", Sha256::digest(signature.to_string().as_bytes()))
}

fn file_name(team: &str) -> String {
    format!(
        "team-config-undo-{:x}.json",
        Sha256::digest(team.as_bytes())
    )
}
