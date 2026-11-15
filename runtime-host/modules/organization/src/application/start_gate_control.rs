use platform::trace::session_trace;
use serde_json::json;
use sha2::{Digest, Sha256};

const LEADER_ROLE_ID: &str = "leader";

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
    pub(crate) workspace: Option<crate::RunWorkspace>,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct StartGatePromptPlan {
    run_id: organization::GraphRunId,
    protocol: Option<String>,
    workspace: Option<crate::RunWorkspace>,
    pub(crate) design: bool,
}

impl StartGatePromptPlan {
    pub fn run_id(&self) -> &organization::GraphRunId {
        &self.run_id
    }

    pub fn system_provenance_receipt(&self) -> Option<&str> {
        self.protocol.as_deref()
    }

    pub fn workspace(&self) -> Option<&crate::RunWorkspace> {
        self.workspace.as_ref()
    }
}

pub(crate) fn prepare_prompt(
    store: &mut crate::OrganizationStore,
    lookup: &StartGateRuntimeBindingLookup,
    resolver: &dyn crate::RoleSessionIdentityResolver,
    inject_prompt: bool,
) -> Result<Option<StartGatePromptPlan>, crate::StoreFault> {
    let Some(binding) = resolve_runtime_binding(store.facts(), lookup, resolver) else {
        return Ok(None);
    };
    let run = store.facts().run(&binding.run_id).ok_or(crate::StoreFault::InvalidFacts)?;
    if binding.workspace.is_some() && !run.workspace_ready() {
        return Err(crate::StoreFault::InvalidFacts);
    }
    let inject_prompt = inject_prompt
        && binding.role_id.as_str() == LEADER_ROLE_ID
        && !matches!(binding.start_gate, crate::RunStartGate::Started);
    let design = inject_prompt && matches!(binding.start_gate, crate::RunStartGate::Designing { .. });
    let protocol = if !inject_prompt {
        None
    } else if design {
        let mut entropy = [0u8; 32];
        getrandom::fill(&mut entropy).map_err(|_| crate::StoreFault::InvalidFacts)?;
        let generation = format!("sgg-{:x}", Sha256::digest(entropy));
        store.register_design_prompt(&binding.run_id, generation.clone())?;
        let run = store
            .facts()
            .run(&binding.run_id)
            .ok_or(crate::StoreFault::InvalidFacts)?;
        Some(super::design_prompt::compose(store.facts(), run, &generation))
    } else {
        Some(store.facts().team_prompts().text("discussion.body.body").to_owned())
    };
    Ok(Some(StartGatePromptPlan {
        run_id: binding.run_id,
        protocol,
        workspace: binding.workspace,
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
        session_trace("runtime.start-gate.binding", || json!({ "outcome": "unmatched" }));
        return None;
    };
    if matches.next().is_some() {
        session_trace("runtime.start-gate.binding", || json!({ "outcome": "ambiguous" }));
        return None;
    }
    session_trace("runtime.start-gate.binding", || json!({
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
        workspace: run.workspace().cloned(),
    })
}
