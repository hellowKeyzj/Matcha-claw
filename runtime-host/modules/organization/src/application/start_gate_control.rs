use platform::trace::session_trace;
use serde_json::json;
use sha2::{Digest, Sha256};

const LEADER_ROLE_ID: &str = "leader";

const TEAM_DISCUSSION_PROMPT: &str = "你负责与用户讨论当前团队的任务，明确目标、交付物、范围和约束。\n\n信息足够时直接给出推荐方案及关键取舍；仅当缺失信息会改变任务范围、交付物或关键依赖时提问，不反复确认已明确的要求。\n\n区分用户已确认的要求、你的建议和待确认的假设；不把讨论结论表述为已保存的工作流或已执行的结果。\n\n本阶段只讨论和分析，不修改运行图、不启动 Run、不派发或执行节点任务。";

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum StartGateRuntimeBindingLookup {
    AgentScoped {
        endpoint: organization::RuntimeEndpointReference,
        agent: organization::ManagedAgentReference,
        session_key: String,
    },
    NativeSession {
        endpoint: organization::RuntimeEndpointReference,
        endpoint_session_id: organization::EndpointSessionId,
    },
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) struct StartGateBinding {
    pub(crate) run_id: organization::GraphRunId,
    pub(crate) role_id: organization::RoleId,
    pub(crate) start_gate: organization::RunStartGate,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct StartGatePromptPlan {
    run_id: organization::GraphRunId,
    protocol: String,
    pub(crate) design: bool,
}

impl StartGatePromptPlan {
    pub fn run_id(&self) -> &organization::GraphRunId {
        &self.run_id
    }

    pub fn system_provenance_receipt(&self) -> &str {
        &self.protocol
    }
}

pub(crate) fn prepare_prompt(
    store: &mut crate::OrganizationStore,
    lookup: &StartGateRuntimeBindingLookup,
    resolver: &dyn crate::RoleSessionIdentityResolver,
) -> Result<Option<StartGatePromptPlan>, crate::StoreFault> {
    let Some(binding) = resolve_runtime_binding(store.facts(), lookup, resolver) else {
        return Ok(None);
    };
    if binding.role_id.as_str() != LEADER_ROLE_ID
        || matches!(binding.start_gate, crate::RunStartGate::Started)
    {
        session_trace("runtime.start-gate.prompt", json!({
            "outcome": "skipped",
            "reason": if binding.role_id.as_str() != LEADER_ROLE_ID { "non_leader" } else { "started" },
        }));
        return Ok(None);
    }
    let design = matches!(binding.start_gate, crate::RunStartGate::Designing { .. });
    let protocol = if design {
        let mut entropy = [0u8; 32];
        getrandom::fill(&mut entropy).map_err(|_| crate::StoreFault::InvalidFacts)?;
        let generation = format!("sgg-{:x}", Sha256::digest(entropy));
        store.register_design_prompt(&binding.run_id, generation.clone())?;
        let run = store
            .facts()
            .run(&binding.run_id)
            .ok_or(crate::StoreFault::InvalidFacts)?;
        super::design_prompt::compose(store.facts(), run, &generation)
    } else {
        TEAM_DISCUSSION_PROMPT.to_owned()
    };
    Ok(Some(StartGatePromptPlan {
        run_id: binding.run_id,
        protocol,
        design,
    }))
}

pub(crate) fn resolve_runtime_binding(
    facts: &organization::OrganizationFacts,
    lookup: &StartGateRuntimeBindingLookup,
    resolver: &dyn crate::RoleSessionIdentityResolver,
) -> Option<StartGateBinding> {
    let mut matches = facts.runs().flat_map(|run| {
        run.runtime().into_iter().flat_map(move |receipt| {
            receipt.bindings().iter().filter_map(move |binding| {
                let matched = binding.team() == run.team()
                    && binding.team_run() == run.run_id()
                    && match lookup {
                        StartGateRuntimeBindingLookup::AgentScoped {
                            endpoint,
                            agent,
                            session_key,
                        } => {
                            binding.endpoint() == endpoint
                                && binding.agent() == agent
                                && resolver.session_key(binding).as_deref()
                                    == Some(session_key.as_str())
                        }
                        StartGateRuntimeBindingLookup::NativeSession {
                            endpoint,
                            endpoint_session_id,
                        } => {
                            binding.endpoint() == endpoint
                                && binding.endpoint_session_id() == endpoint_session_id
                        }
                    };
                matched.then_some((run, binding))
            })
        })
    });
    let Some((run, binding)) = matches.next() else {
        session_trace("runtime.start-gate.binding", json!({ "outcome": "unmatched" }));
        return None;
    };
    if matches.next().is_some() {
        session_trace("runtime.start-gate.binding", json!({ "outcome": "ambiguous" }));
        return None;
    }
    session_trace("runtime.start-gate.binding", json!({
        "outcome": "matched",
        "role": if binding.role().as_str() == LEADER_ROLE_ID { "leader" } else { "member" },
        "gate": match run.start_gate() {
            crate::RunStartGate::Intake => "intake",
            crate::RunStartGate::Designing { .. } => "designing",
            crate::RunStartGate::Started => "started",
        },
    }));
    Some(StartGateBinding {
        run_id: binding.team_run().clone(),
        role_id: binding.role().clone(),
        start_gate: run.start_gate().clone(),
    })
}
