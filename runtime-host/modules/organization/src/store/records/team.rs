use serde::{Deserialize, Serialize, de::DeserializeOwned};

use crate::{
    GraphRunId, IdempotencyKey, ManagedAgentReference, MaterializationReceipt,
    MaterializationRejection, MaterializationSource, MemberId, RoleAgentMaterialization,
    RoleAssignment, RoleId, RoleKind, RoleMaterializationAgent, RoleMaterializationOwnership,
    RoleMaterializationReceipt, RuntimeEndpointReference, TeamDefinition, TeamId,
    TeamMaterializationCleanup, TeamMaterializationIntent, TeamMaterializationLifecycle,
    TeamMaterializationRemoval, TeamMaterializationRequest, TeamMember, TeamRevision, TeamRole,
    TombstonedMaterialization,
    ports::materialization::NativeWorkspaceReceipt,
    run::{WorkflowPlan, WorkflowTask},
    store::{
        PendingWorkflowPlanAdmission, StoreFault, TeamFacts, WorkflowTemplateFacts,
        content::{ContentRef, ContentScope, ContentStore},
        facts::PurgedRunMarker,
        schema::{RecordKey, RecordKind, StoredRecord},
    },
};

pub(in crate::store) enum TeamRecord {
    Team(TeamFacts),
    Materialization(TeamMaterializationLifecycle),
    WorkflowTemplate(WorkflowTemplateFacts),
    WorkflowAdmission(PendingWorkflowPlanAdmission),
    PurgedRun(PurgedRunMarker),
}

#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Body {
    sha256: [u8; 32],
    byte_len: u64,
}

impl Body {
    fn put(content: &ContentStore, team: &TeamId, bytes: &[u8]) -> Result<Self, StoreFault> {
        let reference = content.put(ContentScope::Team(team), bytes)?;
        Ok(Self {
            sha256: reference.sha256,
            byte_len: reference.byte_len,
        })
    }

    fn read(self, content: &ContentStore, team: &TeamId) -> Result<Vec<u8>, StoreFault> {
        content.read(
            ContentScope::Team(team),
            &ContentRef {
                sha256: self.sha256,
                byte_len: self.byte_len,
            },
        )
    }

    fn text(self, content: &ContentStore, team: &TeamId) -> Result<String, StoreFault> {
        String::from_utf8(self.read(content, team)?).map_err(|_| StoreFault::InvalidFacts)
    }
}

#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct TeamRow {
    team_id: String,
    name: String,
    members: Vec<(String, String)>,
    roles: Vec<(String, String, Kind)>,
    assignments: Vec<(String, String)>,
    revision: u64,
    tombstoned: bool,
}

#[derive(Serialize, Deserialize)]
enum Kind {
    Leader,
    Member,
}

#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct MaterializationRow {
    team_id: String,
    lifecycle: Lifecycle,
}

#[derive(Serialize, Deserialize)]
enum Lifecycle {
    Requested(Request),
    Rejected {
        request: Request,
        rejection: Rejection,
    },
    OutcomeUnknown(Request),
    Confirmed(Receipt),
    TombstonedNone(Request),
    TombstonedUnknown(Request),
    TombstonedConfirmed {
        receipt: Receipt,
        cleanup: Cleanup,
    },
}

#[derive(Serialize, Deserialize)]
enum Rejection {
    Permanent,
    Retryable,
}

impl From<MaterializationRejection> for Rejection {
    fn from(value: MaterializationRejection) -> Self {
        match value {
            MaterializationRejection::Permanent => Self::Permanent,
            MaterializationRejection::Retryable => Self::Retryable,
        }
    }
}

impl From<Rejection> for MaterializationRejection {
    fn from(value: Rejection) -> Self {
        match value {
            Rejection::Permanent => Self::Permanent,
            Rejection::Retryable => Self::Retryable,
        }
    }
}

#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Request {
    endpoint: String,
    source: Source,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    source_agent: Option<String>,
    agents: Vec<Agent>,
    idempotency_key: String,
}

#[derive(Serialize, Deserialize)]
enum Source {
    Manual,
    TeamSkill,
}

#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Agent {
    role: String,
    binding: Binding,
    tools: Vec<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    skills: Vec<String>,
    agents_markdown: Option<Body>,
}

#[derive(Serialize, Deserialize)]
enum Binding {
    Managed { name: String },
    External { agent: String },
}

#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Receipt {
    endpoint: String,
    roles: Vec<RoleReceipt>,
}

#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct RoleReceipt {
    role: String,
    agent: String,
    ownership: Ownership,
    endpoint: String,
    native_workspace: Option<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    skills: Vec<(String, [u8; 32])>,
    agents_markdown: Option<Body>,
}

#[derive(Serialize, Deserialize)]
enum Ownership {
    Managed,
    External,
}

#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Removal {
    receipt: Receipt,
    idempotency_key: String,
}

#[derive(Serialize, Deserialize)]
enum Cleanup {
    Pending(Removal),
    Confirmed(Removal),
    Rejected {
        removal: Removal,
        rejection: Rejection,
    },
    OutcomeUnknown(Removal),
}

#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct TemplateRow {
    team_id: String,
    source_identity: String,
    revision: u64,
    plan: Plan,
}

#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Plan {
    workflow_plan_id: String,
    run_id: String,
    title: String,
    status: String,
    tasks: Vec<Task>,
    idempotency_key: String,
    created_at: u64,
}

#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Task {
    task_id: String,
    role_id: String,
    title: String,
    prompt: Body,
    depends_on_task_ids: Vec<String>,
    output_artifact_kind: Option<String>,
}

#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct AdmissionRow {
    team_id: String,
    run_id: String,
    creation_idempotency_key: String,
    team_revision: u64,
    source_identity: String,
    created_at: u64,
}

#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct PurgedRow {
    run_id: String,
    idempotency_key: String,
    purged_at: u64,
}

pub(in crate::store) fn encode_team(team: &TeamFacts) -> Result<StoredRecord, StoreFault> {
    let definition = team.definition();
    store_record(
        RecordKind::Team,
        team.team_id().as_str(),
        Some(team.team_id().as_str()),
        None,
        TeamRow {
            team_id: team.team_id().as_str().to_owned(),
            name: definition.name().to_owned(),
            members: definition
                .members()
                .iter()
                .map(|member| {
                    (
                        member.member_id().as_str().to_owned(),
                        member.name().to_owned(),
                    )
                })
                .collect(),
            roles: definition
                .roles()
                .iter()
                .map(|role| {
                    (
                        role.role_id().as_str().to_owned(),
                        role.name().to_owned(),
                        match role.kind() {
                            RoleKind::Leader => Kind::Leader,
                            RoleKind::Member => Kind::Member,
                        },
                    )
                })
                .collect(),
            assignments: definition
                .assignments()
                .iter()
                .map(|assignment| {
                    (
                        assignment.member_id().as_str().to_owned(),
                        assignment.role_id().as_str().to_owned(),
                    )
                })
                .collect(),
            revision: team.revision().get(),
            tombstoned: team.tombstoned(),
        },
    )
}

pub(in crate::store) fn encode_materialization(
    lifecycle: &TeamMaterializationLifecycle,
    content: &ContentStore,
) -> Result<StoredRecord, StoreFault> {
    let team = lifecycle.team().ok_or(StoreFault::InvalidFacts)?;
    let value = match lifecycle {
        TeamMaterializationLifecycle::Requested(request) => {
            Lifecycle::Requested(Request::encode(request, content)?)
        }
        TeamMaterializationLifecycle::Rejected { request, rejection } => Lifecycle::Rejected {
            request: Request::encode(request, content)?,
            rejection: (*rejection).into(),
        },
        TeamMaterializationLifecycle::OutcomeUnknown(request) => {
            Lifecycle::OutcomeUnknown(Request::encode(request, content)?)
        }
        TeamMaterializationLifecycle::Confirmed(receipt) => {
            Lifecycle::Confirmed(Receipt::encode(receipt, content)?)
        }
        TeamMaterializationLifecycle::Tombstoned(TombstonedMaterialization::None(request)) => {
            Lifecycle::TombstonedNone(Request::encode(request, content)?)
        }
        TeamMaterializationLifecycle::Tombstoned(TombstonedMaterialization::OutcomeUnknown(
            request,
        )) => Lifecycle::TombstonedUnknown(Request::encode(request, content)?),
        TeamMaterializationLifecycle::Tombstoned(TombstonedMaterialization::Confirmed {
            receipt,
            cleanup,
        }) => {
            let cleanup = match cleanup {
                TeamMaterializationCleanup::Pending(removal) => {
                    Cleanup::Pending(Removal::encode(removal, team, content)?)
                }
                TeamMaterializationCleanup::Confirmed(removal) => {
                    Cleanup::Confirmed(Removal::encode(removal, team, content)?)
                }
                TeamMaterializationCleanup::Rejected { removal, rejection } => Cleanup::Rejected {
                    removal: Removal::encode(removal, team, content)?,
                    rejection: (*rejection).into(),
                },
                TeamMaterializationCleanup::OutcomeUnknown(removal) => {
                    Cleanup::OutcomeUnknown(Removal::encode(removal, team, content)?)
                }
            };
            Lifecycle::TombstonedConfirmed {
                receipt: Receipt::encode(receipt, content)?,
                cleanup,
            }
        }
    };
    store_record(
        RecordKind::Materialization,
        team.as_str(),
        Some(team.as_str()),
        None,
        MaterializationRow {
            team_id: team.as_str().to_owned(),
            lifecycle: value,
        },
    )
}

pub(in crate::store) fn encode_template(
    template: &WorkflowTemplateFacts,
    content: &ContentStore,
) -> Result<StoredRecord, StoreFault> {
    let plan = template.plan();
    let plan = Plan {
        workflow_plan_id: plan.workflow_plan_id().to_owned(),
        run_id: plan.run_id().to_owned(),
        title: plan.title().to_owned(),
        status: plan.status().to_owned(),
        tasks: plan
            .tasks()
            .iter()
            .map(|task| {
                Ok(Task {
                    task_id: task.task_id().to_owned(),
                    role_id: task.role_id().to_owned(),
                    title: task.title().to_owned(),
                    prompt: Body::put(content, template.team(), task.prompt().as_bytes())?,
                    depends_on_task_ids: task.depends_on_task_ids().to_vec(),
                    output_artifact_kind: task.output_artifact_kind().map(str::to_owned),
                })
            })
            .collect::<Result<Vec<_>, StoreFault>>()?,
        idempotency_key: plan.idempotency_key().to_owned(),
        created_at: plan.created_at(),
    };
    store_record(
        RecordKind::WorkflowTemplate,
        template.team().as_str(),
        Some(template.team().as_str()),
        None,
        TemplateRow {
            team_id: template.team().as_str().to_owned(),
            source_identity: template.source_identity().to_owned(),
            revision: template.revision(),
            plan,
        },
    )
}

pub(in crate::store) fn encode_admission(
    admission: &PendingWorkflowPlanAdmission,
) -> Result<StoredRecord, StoreFault> {
    store_record(
        RecordKind::WorkflowAdmission,
        admission.run_id().as_str(),
        Some(admission.team_id().as_str()),
        Some(admission.run_id().as_str()),
        AdmissionRow {
            team_id: admission.team_id().as_str().to_owned(),
            run_id: admission.run_id().as_str().to_owned(),
            creation_idempotency_key: admission.creation_idempotency_key().to_owned(),
            team_revision: admission.team_revision().get(),
            source_identity: admission.source_identity().to_owned(),
            created_at: admission.created_at(),
        },
    )
}

pub(in crate::store) fn encode_purged(
    marker: &PurgedRunMarker,
) -> Result<StoredRecord, StoreFault> {
    store_record(
        RecordKind::PurgedRun,
        marker.run_id().as_str(),
        None,
        Some(marker.run_id().as_str()),
        PurgedRow {
            run_id: marker.run_id().as_str().to_owned(),
            idempotency_key: marker.idempotency_key().to_owned(),
            purged_at: marker.purged_at(),
        },
    )
}

pub(in crate::store) fn decode(
    record: &StoredRecord,
    content: &ContentStore,
) -> Result<TeamRecord, StoreFault> {
    match record.key.kind {
        RecordKind::Team => {
            let row: TeamRow = read_record(record)?;
            check_key(record, &row.team_id, Some(&row.team_id), None)?;
            let members = row
                .members
                .into_iter()
                .map(|(id, name)| {
                    TeamMember::try_new(
                        MemberId::try_new(id).map_err(|_| StoreFault::InvalidFacts)?,
                        name,
                    )
                    .map_err(|_| StoreFault::InvalidFacts)
                })
                .collect::<Result<Vec<_>, _>>()?;
            let roles = row
                .roles
                .into_iter()
                .map(|(id, name, kind)| {
                    TeamRole::try_new(
                        RoleId::try_new(id).map_err(|_| StoreFault::InvalidFacts)?,
                        name,
                        match kind {
                            Kind::Leader => RoleKind::Leader,
                            Kind::Member => RoleKind::Member,
                        },
                    )
                    .map_err(|_| StoreFault::InvalidFacts)
                })
                .collect::<Result<Vec<_>, _>>()?;
            let assignments = row
                .assignments
                .into_iter()
                .map(|(member, role)| {
                    Ok(RoleAssignment::new(
                        MemberId::try_new(member).map_err(|_| StoreFault::InvalidFacts)?,
                        RoleId::try_new(role).map_err(|_| StoreFault::InvalidFacts)?,
                    ))
                })
                .collect::<Result<Vec<_>, StoreFault>>()?;
            let definition = TeamDefinition::try_new(
                TeamId::try_new(row.team_id).map_err(|_| StoreFault::InvalidFacts)?,
                row.name,
                members,
                roles,
                assignments,
            )
            .map_err(|_| StoreFault::InvalidFacts)?;
            Ok(TeamRecord::Team(TeamFacts::new(
                definition,
                TeamRevision::try_new(row.revision).map_err(|_| StoreFault::InvalidFacts)?,
                row.tombstoned,
            )))
        }
        RecordKind::Materialization => {
            let row: MaterializationRow = read_record(record)?;
            check_key(record, &row.team_id, Some(&row.team_id), None)?;
            let team = TeamId::try_new(row.team_id).map_err(|_| StoreFault::InvalidFacts)?;
            let lifecycle = match row.lifecycle {
                Lifecycle::Requested(request) => {
                    TeamMaterializationLifecycle::Requested(request.decode(&team, content)?)
                }
                Lifecycle::Rejected { request, rejection } => {
                    TeamMaterializationLifecycle::Rejected {
                        request: request.decode(&team, content)?,
                        rejection: rejection.into(),
                    }
                }
                Lifecycle::OutcomeUnknown(request) => {
                    TeamMaterializationLifecycle::OutcomeUnknown(request.decode(&team, content)?)
                }
                Lifecycle::Confirmed(receipt) => {
                    TeamMaterializationLifecycle::Confirmed(receipt.decode(&team, content)?)
                }
                Lifecycle::TombstonedNone(request) => TeamMaterializationLifecycle::Tombstoned(
                    TombstonedMaterialization::None(request.decode(&team, content)?),
                ),
                Lifecycle::TombstonedUnknown(request) => TeamMaterializationLifecycle::Tombstoned(
                    TombstonedMaterialization::OutcomeUnknown(request.decode(&team, content)?),
                ),
                Lifecycle::TombstonedConfirmed { receipt, cleanup } => {
                    let cleanup = match cleanup {
                        Cleanup::Pending(removal) => {
                            TeamMaterializationCleanup::Pending(removal.decode(&team, content)?)
                        }
                        Cleanup::Confirmed(removal) => {
                            TeamMaterializationCleanup::Confirmed(removal.decode(&team, content)?)
                        }
                        Cleanup::Rejected { removal, rejection } => {
                            TeamMaterializationCleanup::Rejected {
                                removal: removal.decode(&team, content)?,
                                rejection: rejection.into(),
                            }
                        }
                        Cleanup::OutcomeUnknown(removal) => {
                            TeamMaterializationCleanup::OutcomeUnknown(
                                removal.decode(&team, content)?,
                            )
                        }
                    };
                    TeamMaterializationLifecycle::Tombstoned(TombstonedMaterialization::Confirmed {
                        receipt: receipt.decode(&team, content)?,
                        cleanup,
                    })
                }
            };
            Ok(TeamRecord::Materialization(lifecycle))
        }
        RecordKind::WorkflowTemplate => {
            let row: TemplateRow = read_record(record)?;
            check_key(record, &row.team_id, Some(&row.team_id), None)?;
            let team = TeamId::try_new(row.team_id).map_err(|_| StoreFault::InvalidFacts)?;
            let plan = row.plan;
            let tasks = plan
                .tasks
                .into_iter()
                .map(|task| {
                    Ok(WorkflowTask::new(
                        task.task_id,
                        task.role_id,
                        task.title,
                        task.prompt.text(content, &team)?,
                        task.depends_on_task_ids,
                        task.output_artifact_kind,
                    ))
                })
                .collect::<Result<Vec<_>, StoreFault>>()?;
            Ok(TeamRecord::WorkflowTemplate(
                WorkflowTemplateFacts::from_plan(
                    team,
                    row.source_identity,
                    row.revision,
                    WorkflowPlan::new(
                        plan.workflow_plan_id,
                        plan.run_id,
                        plan.title,
                        plan.status,
                        tasks,
                        plan.idempotency_key,
                        plan.created_at,
                    ),
                )
                .map_err(|_| StoreFault::InvalidFacts)?,
            ))
        }
        RecordKind::WorkflowAdmission => {
            let row: AdmissionRow = read_record(record)?;
            check_key(record, &row.run_id, Some(&row.team_id), Some(&row.run_id))?;
            Ok(TeamRecord::WorkflowAdmission(
                PendingWorkflowPlanAdmission::try_new(
                    TeamId::try_new(row.team_id).map_err(|_| StoreFault::InvalidFacts)?,
                    GraphRunId::new(row.run_id),
                    row.creation_idempotency_key,
                    TeamRevision::try_new(row.team_revision)
                        .map_err(|_| StoreFault::InvalidFacts)?,
                    row.source_identity,
                    row.created_at,
                )
                .map_err(|_| StoreFault::InvalidFacts)?,
            ))
        }
        RecordKind::PurgedRun => {
            let row: PurgedRow = read_record(record)?;
            check_key(record, &row.run_id, None, Some(&row.run_id))?;
            Ok(TeamRecord::PurgedRun(
                PurgedRunMarker::try_new(
                    GraphRunId::new(row.run_id),
                    row.idempotency_key,
                    row.purged_at,
                )
                .map_err(|_| StoreFault::InvalidFacts)?,
            ))
        }
        _ => Err(StoreFault::CorruptRecord),
    }
}

impl Request {
    fn encode(
        request: &TeamMaterializationRequest,
        content: &ContentStore,
    ) -> Result<Self, StoreFault> {
        let intent = request.intent();
        let agents = intent
            .agents()
            .iter()
            .map(|agent| {
                Ok(Agent {
                    role: agent.role().as_str().to_owned(),
                    binding: match agent.agent() {
                        RoleMaterializationAgent::Managed { name } => {
                            Binding::Managed { name: name.clone() }
                        }
                        RoleMaterializationAgent::External { agent } => Binding::External {
                            agent: agent.as_str().to_owned(),
                        },
                    },
                    tools: agent.tools().to_vec(),
                    skills: agent.skills().to_vec(),
                    agents_markdown: agent
                        .agents_markdown()
                        .map(|text| Body::put(content, intent.team(), text.as_bytes()))
                        .transpose()?,
                })
            })
            .collect::<Result<Vec<_>, StoreFault>>()?;
        Ok(Self {
            endpoint: intent.endpoint().as_str().to_owned(),
            source_agent: intent.source_agent().map(|agent| agent.as_str().to_owned()),
            source: match intent.source() {
                MaterializationSource::Manual => Source::Manual,
                MaterializationSource::TeamSkill => Source::TeamSkill,
            },
            agents,
            idempotency_key: request.idempotency_key().as_str().to_owned(),
        })
    }

    fn decode(
        self,
        team: &TeamId,
        content: &ContentStore,
    ) -> Result<TeamMaterializationRequest, StoreFault> {
        let agents = self
            .agents
            .into_iter()
            .map(|agent| {
                let role = RoleId::try_new(agent.role).map_err(|_| StoreFault::InvalidFacts)?;
                let mut value = match agent.binding {
                    Binding::Managed { name } => RoleAgentMaterialization::managed(role, name)
                        .map_err(|_| StoreFault::InvalidFacts)?,
                    Binding::External { agent } => RoleAgentMaterialization::external(
                        role,
                        ManagedAgentReference::try_new(agent)
                            .map_err(|_| StoreFault::InvalidFacts)?,
                    ),
                }
                .with_tools(agent.tools).with_skills(agent.skills);
                if let Some(body) = agent.agents_markdown {
                    value = value.with_agents_markdown(body.text(content, team)?);
                }
                Ok(value)
            })
            .collect::<Result<Vec<_>, StoreFault>>()?;
        let intent = TeamMaterializationIntent::try_new(
            team.clone(),
            RuntimeEndpointReference::try_new(self.endpoint)
                .map_err(|_| StoreFault::InvalidFacts)?,
            match self.source {
                Source::Manual => MaterializationSource::Manual,
                Source::TeamSkill => MaterializationSource::TeamSkill,
            },
            agents,
        )
        .map_err(|_| StoreFault::InvalidFacts)?
        .with_source_agent(self.source_agent.map(ManagedAgentReference::try_new).transpose().map_err(|_| StoreFault::InvalidFacts)?);
        Ok(TeamMaterializationRequest::new(
            intent,
            IdempotencyKey::try_new(self.idempotency_key).map_err(|_| StoreFault::InvalidFacts)?,
        ))
    }
}

impl Receipt {
    fn encode(
        receipt: &MaterializationReceipt,
        content: &ContentStore,
    ) -> Result<Self, StoreFault> {
        let roles = receipt
            .roles()
            .iter()
            .map(|role| {
                Ok(RoleReceipt {
                    role: role.role().as_str().to_owned(),
                    agent: role.agent().as_str().to_owned(),
                    ownership: match role.ownership() {
                        RoleMaterializationOwnership::Managed => Ownership::Managed,
                        RoleMaterializationOwnership::External => Ownership::External,
                    },
                    endpoint: role.endpoint().as_str().to_owned(),
                    skills: role.skills().to_vec(),
                    native_workspace: role
                        .native_workspace()
                        .map(|workspace| workspace.as_str().to_owned()),
                    agents_markdown: role
                        .agents_markdown()
                        .map(|text| Body::put(content, receipt.team(), text.as_bytes()))
                        .transpose()?,
                })
            })
            .collect::<Result<Vec<_>, StoreFault>>()?;
        Ok(Self {
            endpoint: receipt.endpoint().as_str().to_owned(),
            roles,
        })
    }

    fn decode(
        self,
        team: &TeamId,
        content: &ContentStore,
    ) -> Result<MaterializationReceipt, StoreFault> {
        let roles = self
            .roles
            .into_iter()
            .map(|role| {
                let id = RoleId::try_new(role.role).map_err(|_| StoreFault::InvalidFacts)?;
                let agent = ManagedAgentReference::try_new(role.agent)
                    .map_err(|_| StoreFault::InvalidFacts)?;
                let ownership = match role.ownership {
                    Ownership::Managed => RoleMaterializationOwnership::Managed,
                    Ownership::External => RoleMaterializationOwnership::External,
                };
                let endpoint = RuntimeEndpointReference::try_new(role.endpoint)
                    .map_err(|_| StoreFault::InvalidFacts)?;
                let mut receipt = match role.native_workspace {
                    Some(workspace) => RoleMaterializationReceipt::with_native_workspace(
                        id,
                        agent,
                        ownership,
                        endpoint,
                        NativeWorkspaceReceipt::try_new(workspace)
                            .map_err(|_| StoreFault::InvalidFacts)?,
                    ),
                    None => {
                        RoleMaterializationReceipt::with_ownership(id, agent, ownership, endpoint)
                    }
                };
                receipt = receipt.with_skills(role.skills);
                if let Some(body) = role.agents_markdown {
                    receipt = receipt.with_agents_markdown(body.text(content, team)?);
                }
                Ok(receipt)
            })
            .collect::<Result<Vec<_>, StoreFault>>()?;
        MaterializationReceipt::try_new(
            team.clone(),
            RuntimeEndpointReference::try_new(self.endpoint)
                .map_err(|_| StoreFault::InvalidFacts)?,
            roles,
        )
        .map_err(|_| StoreFault::InvalidFacts)
    }
}

impl Removal {
    fn encode(
        removal: &TeamMaterializationRemoval,
        team: &TeamId,
        content: &ContentStore,
    ) -> Result<Self, StoreFault> {
        if removal.receipt().team() != team {
            return Err(StoreFault::InvalidFacts);
        }
        Ok(Self {
            receipt: Receipt::encode(removal.receipt(), content)?,
            idempotency_key: removal.idempotency_key().as_str().to_owned(),
        })
    }

    fn decode(
        self,
        team: &TeamId,
        content: &ContentStore,
    ) -> Result<TeamMaterializationRemoval, StoreFault> {
        Ok(TeamMaterializationRemoval::new(
            self.receipt.decode(team, content)?,
            IdempotencyKey::try_new(self.idempotency_key).map_err(|_| StoreFault::InvalidFacts)?,
        ))
    }
}

fn store_record<T: Serialize>(
    kind: RecordKind,
    id: &str,
    team_id: Option<&str>,
    run_id: Option<&str>,
    value: T,
) -> Result<StoredRecord, StoreFault> {
    Ok(StoredRecord {
        key: RecordKey {
            kind,
            scope: String::new(),
            id: id.to_owned(),
        },
        team_id: team_id.map(str::to_owned),
        run_id: run_id.map(str::to_owned),
        payload: serde_json::to_vec(&value).map_err(|_| StoreFault::InvalidFacts)?,
    })
}

fn read_record<T: DeserializeOwned>(record: &StoredRecord) -> Result<T, StoreFault> {
    serde_json::from_slice(&record.payload).map_err(|_| StoreFault::CorruptRecord)
}

fn check_key(
    record: &StoredRecord,
    id: &str,
    team: Option<&str>,
    run: Option<&str>,
) -> Result<(), StoreFault> {
    if !record.key.scope.is_empty()
        || record.key.id != id
        || record.team_id.as_deref() != team
        || record.run_id.as_deref() != run
    {
        return Err(StoreFault::CorruptRecord);
    }
    Ok(())
}
