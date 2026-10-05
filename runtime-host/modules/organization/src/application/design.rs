use super::team_runtime::TeamGraphPatchDraft;
use crate::{
    GraphRunFacts, GraphRunId, OrganizationFacts, OrganizationStore, RunStartGate, StoreFault,
    TeamId,
};
use serde_json::{Value, json};

pub enum DesignOperation {
    Begin {
        team_id: TeamId,
        run_id: GraphRunId,
        epoch: String,
        proposal_id: Option<String>,
    },
    Exit {
        team_id: TeamId,
        run_id: GraphRunId,
        epoch: String,
    },
    Snapshot {
        team_id: TeamId,
        run_id: GraphRunId,
    },
    Context {
        team_id: TeamId,
        run_id: GraphRunId,
        epoch: String,
        generation: String,
    },
    Patch {
        team_id: TeamId,
        epoch: String,
        generation: Option<String>,
        version: String,
        patch: TeamGraphPatchDraft,
    },
}

impl DesignOperation {
    pub(crate) fn run_id(&self) -> &GraphRunId {
        match self {
            Self::Begin { run_id, .. }
            | Self::Exit { run_id, .. }
            | Self::Snapshot { run_id, .. }
            | Self::Context { run_id, .. } => run_id,
            Self::Patch { patch, .. } => &patch.run_id,
        }
    }
}

pub(crate) fn decode(
    operation: &str,
    input: &serde_json::Map<String, Value>,
    target: &Value,
) -> Result<super::team_runtime::TeamRuntimeCommand, super::team_runtime::TeamRuntimeDecodeError> {
    use super::team_runtime::TeamRuntimeDecodeError::InvalidInput;
    let field = |key: &str| {
        input
            .get(key)
            .and_then(Value::as_str)
            .filter(|value| !value.trim().is_empty())
            .map(str::to_owned)
            .ok_or(InvalidInput)
    };
    let team_id = TeamId::try_new(field("teamId")?).map_err(|_| InvalidInput)?;
    if target != &json!({"kind":"team","teamId":team_id.as_str()}) {
        return Err(InvalidInput);
    }
    let run_id = GraphRunId::new(field("runId")?);
    let allowed: &[&str] = match operation {
        "team.designSnapshot" => &["teamId", "runId"],
        "team.designExit" => &["teamId", "runId", "designEpoch"],
        "team.designStart" => &["teamId", "runId", "idempotencyKey"],
        "team.designContinue" => &["teamId", "runId", "idempotencyKey", "proposalId"],
        "team.designGraphPatch" => &[
            "teamId",
            "runId",
            "designEpoch",
            "expectedGraphVersion",
            "commandId",
            "idempotencyKey",
            "operations",
        ],
        _ => return Err(InvalidInput),
    };
    if input.len() != allowed.len() || input.keys().any(|key| !allowed.contains(&key.as_str())) {
        return Err(InvalidInput);
    }
    let operation = match operation {
        "team.designSnapshot" => DesignOperation::Snapshot { team_id, run_id },
        "team.designExit" => DesignOperation::Exit {
            team_id,
            run_id,
            epoch: crate::run::event::OpaqueId::try_new(field("designEpoch")?)
                .map_err(|_| InvalidInput)?
                .as_str()
                .to_owned(),
        },
        "team.designStart" | "team.designContinue" => {
            let epoch = field("idempotencyKey")?;
            crate::run::event::OpaqueId::try_new(epoch.clone()).map_err(|_| InvalidInput)?;
            DesignOperation::Begin {
                team_id,
                run_id,
                epoch,
                proposal_id: if operation == "team.designContinue" {
                    Some(field("proposalId")?)
                } else {
                    None
                },
            }
        }
        _ => {
            let opaque =
                |key| crate::run::event::OpaqueId::try_new(field(key)?).map_err(|_| InvalidInput);
            let patch = super::team_runtime::decode_team_graph_patch_value(
                &json!({"operations":input["operations"]}),
                run_id.clone(),
                crate::run::event::OpaqueId::try_new(run_id.as_str()).map_err(|_| InvalidInput)?,
                opaque("commandId")?,
                opaque("idempotencyKey")?,
            )?;
            DesignOperation::Patch {
                team_id,
                epoch: field("designEpoch")?,
                generation: None,
                version: field("expectedGraphVersion")?,
                patch,
            }
        }
    };
    Ok(super::team_runtime::TeamRuntimeCommand::Design { operation })
}

pub(crate) fn execute(
    store: &mut OrganizationStore,
    operation: DesignOperation,
    resolver: &dyn crate::RoleSessionIdentityResolver,
) -> Result<Value, StoreFault> {
    match operation {
        DesignOperation::Begin {
            team_id,
            run_id,
            epoch,
            proposal_id,
        } => {
            store.begin_design(&team_id, &run_id, epoch, proposal_id.as_deref())?;
            Ok(json!({"success":true,"outcome":"designing"}))
        }
        DesignOperation::Exit {
            team_id,
            run_id,
            epoch,
        } => {
            store.exit_design(&team_id, &run_id, &epoch)?;
            Ok(json!({"success":true,"outcome":"intake"}))
        }
        DesignOperation::Snapshot { team_id, run_id } => {
            snapshot(store.facts(), &team_id, &run_id, resolver)
        }
        DesignOperation::Context {
            team_id,
            run_id,
            epoch,
            generation,
        } => {
            guard(
                store.facts(),
                &team_id,
                &run_id,
                &epoch,
                Some(&generation),
                None,
            )?;
            snapshot(store.facts(), &team_id, &run_id, resolver)
        }
        DesignOperation::Patch {
            team_id,
            epoch,
            generation,
            version,
            patch,
        } => {
            let run_id = patch.run_id.clone();
            store.design_patch(&team_id, &epoch, generation.as_deref(), &version, patch)?;
            snapshot(store.facts(), &team_id, &run_id, resolver)
        }
    }
}

pub(crate) fn guard(
    facts: &OrganizationFacts,
    team_id: &TeamId,
    run_id: &GraphRunId,
    epoch: &str,
    generation: Option<&str>,
    version: Option<&str>,
) -> Result<(), StoreFault> {
    let run = facts.run(run_id).ok_or(StoreFault::InvalidFacts)?;
    if run.team() != team_id {
        return Err(StoreFault::InvalidFacts);
    }
    let (current_epoch, current_generation) = match run.start_gate() {
        RunStartGate::Designing {
            design_epoch,
            prompt_generation,
        } => (design_epoch.as_str(), prompt_generation.as_deref()),
        RunStartGate::DesignProposalPending {
            design_epoch,
            prompt_generation,
            ..
        } => (design_epoch.as_str(), Some(prompt_generation.as_str())),
        _ => return Err(StoreFault::InvalidFacts),
    };
    if current_epoch != epoch
        || generation.is_some_and(|value| Some(value) != current_generation)
        || version.is_some_and(|value| {
            crate::store::codec::graph_version(run.graph().definition())
                .ok()
                .as_deref()
                != Some(value)
        })
    {
        return Err(StoreFault::InvalidFacts);
    }
    Ok(())
}

pub(crate) fn validate_graph(
    facts: &OrganizationFacts,
    run: &GraphRunFacts,
) -> Result<(), StoreFault> {
    validate_definition(facts, run, run.graph().definition(), true)
}

pub(crate) fn validate_definition(
    facts: &OrganizationFacts,
    run: &GraphRunFacts,
    graph: &crate::GraphDefinition,
    complete: bool,
) -> Result<(), StoreFault> {
    let team = facts.team(run.team()).ok_or(StoreFault::InvalidFacts)?;
    if complete
        && (!graph
            .nodes()
            .iter()
            .any(|node| node.kind() == crate::NodeKind::Start)
            || !graph
                .nodes()
                .iter()
                .any(|node| node.kind() == crate::NodeKind::End))
    {
        return Err(StoreFault::InvalidFacts);
    }
    for node in graph.nodes() {
        let assignment = node
            .work_assignment()
            .map(|work| (work.role_id(), work.session_ref(), work.prompt()))
            .or_else(|| {
                node.review_assignment()
                    .map(|review| (review.role_id(), review.session_ref(), review.prompt()))
            });
        if let Some((role, session_ref, prompt)) = assignment {
            if prompt.trim().is_empty()
                || !team
                    .definition()
                    .roles()
                    .iter()
                    .any(|item| item.role_id().as_str() == role)
                || !run.runtime().is_some_and(|runtime| {
                    runtime.bindings().iter().any(|binding| {
                        binding.role().as_str() == role && binding.session_ref() == session_ref
                    })
                })
            {
                return Err(StoreFault::InvalidFacts);
            }
        } else if matches!(node.kind(), crate::NodeKind::Work | crate::NodeKind::Review) {
            return Err(StoreFault::InvalidFacts);
        }
    }
    if complete {
        let mut reachable = graph
            .nodes()
            .iter()
            .filter(|node| node.kind() == crate::NodeKind::Start)
            .map(|node| node.id().clone())
            .collect::<std::collections::BTreeSet<_>>();
        let mut finishing = graph
            .nodes()
            .iter()
            .filter(|node| node.kind() == crate::NodeKind::End)
            .map(|node| node.id().clone())
            .collect::<std::collections::BTreeSet<_>>();
        loop {
            let before = (reachable.len(), finishing.len());
            for edge in graph
                .edges()
                .iter()
                .filter(|edge| edge.action() != crate::EdgeAction::Rework)
            {
                if reachable.contains(edge.source_node_id()) {
                    reachable.insert(edge.target_node_id().clone());
                }
                if finishing.contains(edge.target_node_id()) {
                    finishing.insert(edge.source_node_id().clone());
                }
            }
            if before == (reachable.len(), finishing.len()) {
                break;
            }
        }
        if graph
            .nodes()
            .iter()
            .any(|node| !reachable.contains(node.id()) || !finishing.contains(node.id()))
        {
            return Err(StoreFault::InvalidFacts);
        }
    }
    Ok(())
}

pub(crate) fn start_gate_json(run: &GraphRunFacts) -> Result<Value, StoreFault> {
    let version = crate::store::codec::graph_version(run.graph().definition())?;
    Ok(match run.start_gate() {
        RunStartGate::Intake => json!({"status":"intake","proposal":null}),
        RunStartGate::Started => json!({"status":"started","proposal":null}),
        RunStartGate::ProposalPending {
            proposal_id,
            summary,
            ..
        } => {
            json!({"status":"proposal_pending","proposal":{"proposalId":proposal_id,"taskSummary":summary}})
        }
        RunStartGate::Designing { design_epoch, .. } => {
            json!({"status":"designing","designEpoch":design_epoch,"graphVersion":version,"proposal":null})
        }
        RunStartGate::DesignProposalPending {
            design_epoch,
            proposal_id,
            summary,
            graph_version,
            ..
        } => {
            json!({"status":"design_proposal_pending","designEpoch":design_epoch,"graphVersion":graph_version,"proposal":{"proposalId":proposal_id,"taskSummary":summary}})
        }
    })
}

pub(crate) fn snapshot(
    facts: &OrganizationFacts,
    team_id: &TeamId,
    run_id: &GraphRunId,
    resolver: &dyn crate::RoleSessionIdentityResolver,
) -> Result<Value, StoreFault> {
    let run = facts
        .run(run_id)
        .filter(|run| run.team() == team_id)
        .ok_or(StoreFault::InvalidFacts)?;
    let public = crate::run::public_projection::graph_projection(facts, run.graph());
    let mut graph =
        super::team_runtime_control::team_public_graph_legacy_json(run_id.as_str(), &public);
    let roles = run
        .runtime()
        .map(|runtime| {
            super::team_runtime_control::team_role_session_receipts_legacy_json(
                runtime.bindings(),
                resolver,
            )
        })
        .unwrap_or_default();
    let definition = run.graph().definition();
    let nodes = definition.nodes().iter().zip(graph["nodes"].as_array().expect("graph node projection")).map(|(node, projected)| {
        let prompt = node.work_assignment().map(|work| work.prompt()).or_else(|| node.review_assignment().map(|review| review.prompt()));
        let mut config = json!({});
        if let Some(prompt) = prompt { config["prompt"] = json!(prompt); }
        if let Some(work) = node.work_assignment() {
            if let Some(kind) = work.output_artifact_kind() { config["outputArtifactKind"] = json!(kind); }
            config["sessionRef"] = json!(work.session_ref().as_str());
        }
        if let Some(review) = node.review_assignment() { config["sessionRef"] = json!(review.session_ref().as_str()); }
        if let Some(trigger) = node.trigger() { config["trigger"] = match trigger { crate::StartTrigger::Webhook { path } => json!({"mode":"webhook","path":path}), crate::StartTrigger::Cron { expression } => json!({"mode":"cron","cron":expression}) }; }
        if let Some(group) = node.work_group() { config["join"] = json!({"requireCompleted":group.join_policy().require_completed(),"allowFailed":group.join_policy().allow_failed(),"retryLimit":group.join_policy().retry_limit()}); }
        let mut projected = projected.clone();
        projected["config"] = config;
        projected["roleId"] = json!(node.work_assignment().map(|work|work.role_id()).or_else(||node.review_assignment().map(|review|review.role_id())));
        projected["groupId"] = json!(node.work_assignment().and_then(|work|work.group_id()).or_else(||node.work_group().map(|group|group.id())).map(|group|group.as_str()));
        projected
    }).collect::<Vec<_>>();
    let edges = definition.edges().iter().zip(graph["edges"].as_array().expect("graph edge projection")).map(|(edge, projected)| {
        let mut projected = projected.clone();
        projected["payload"] = json!({"includeUpstreamResult":edge.payload().include_upstream_result()});
        projected["dependency"] = json!(edge.dependency().map(|dependency|json!({"dependencyTaskId":dependency.dependency_task_id(),"taskId":dependency.task_id()})));
        projected
    }).collect::<Vec<_>>();
    graph["nodes"] = json!(nodes);
    graph["edges"] = json!(edges);
    let epoch = match run.start_gate() {
        RunStartGate::Designing { design_epoch, .. }
        | RunStartGate::DesignProposalPending { design_epoch, .. } => Some(design_epoch),
        _ => None,
    };
    Ok(
        json!({"success":true,"teamId":team_id.as_str(),"runId":run_id.as_str(),"startGate":start_gate_json(run)?,"graphVersion":crate::store::codec::graph_version(definition)?,"designEpoch":epoch,"graph":graph,"roles":roles}),
    )
}
