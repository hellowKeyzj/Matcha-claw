use std::fmt;

use serde::Serialize;

use crate::exchange::canonical;

/// Address of one native runtime instance behind the Host facade.
///
/// The endpoint names a runtime kind/instance boundary only; it does not carry
/// session, workspace, transcript, process, or capability authority.
#[derive(Clone, Eq, Hash, PartialEq, Serialize)]
pub struct RuntimeEndpoint {
    kind: &'static str,
    #[serde(rename = "runtimeAdapterId")]
    runtime_adapter_id: String,
    #[serde(rename = "runtimeInstanceId")]
    runtime_instance_id: String,
}

impl fmt::Debug for RuntimeEndpoint {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("RuntimeEndpoint(<opaque>)")
    }
}

impl RuntimeEndpoint {
    pub fn try_new(
        runtime_adapter_id: impl Into<String>,
        runtime_instance_id: impl Into<String>,
    ) -> Result<Self, InvalidRuntimeAddress> {
        Ok(Self {
            kind: "native-runtime",
            runtime_adapter_id: identity(runtime_adapter_id.into())?,
            runtime_instance_id: identity(runtime_instance_id.into())?,
        })
    }

    pub fn runtime_adapter_id(&self) -> &str {
        &self.runtime_adapter_id
    }

    pub fn runtime_instance_id(&self) -> &str {
        &self.runtime_instance_id
    }

    pub fn canonical_key(&self) -> String {
        #[derive(Serialize)]
        struct Key<'a> {
            #[serde(rename = "type")]
            wire_type: &'static str,
            kind: &'static str,
            #[serde(rename = "runtimeAdapterId")]
            runtime_adapter_id: &'a str,
            #[serde(rename = "runtimeInstanceId")]
            runtime_instance_id: &'a str,
        }
        canonical::encode(&Key {
            wire_type: "runtime-endpoint",
            kind: self.kind,
            runtime_adapter_id: &self.runtime_adapter_id,
            runtime_instance_id: &self.runtime_instance_id,
        })
    }
}

/// Endpoint-bound native session identity.
///
/// The peer runtime remains the transcript and run-history owner; this value is
/// only the stable address used by Host-facing calls and projections.
#[derive(Clone, Eq, Hash, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionIdentity {
    endpoint: RuntimeEndpoint,
    agent_id: String,
    session_key: String,
}

impl fmt::Debug for SessionIdentity {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("SessionIdentity(<opaque>)")
    }
}

impl SessionIdentity {
    pub fn try_new(
        endpoint: RuntimeEndpoint,
        agent_id: impl Into<String>,
        session_key: impl Into<String>,
    ) -> Result<Self, InvalidRuntimeAddress> {
        Ok(Self {
            endpoint,
            agent_id: identity(agent_id.into())?,
            session_key: identity(session_key.into())?,
        })
    }

    pub fn endpoint(&self) -> &RuntimeEndpoint {
        &self.endpoint
    }

    pub fn agent_id(&self) -> &str {
        &self.agent_id
    }

    pub fn canonical_key(&self) -> String {
        #[derive(Serialize)]
        struct Endpoint<'a> {
            #[serde(rename = "type")]
            wire_type: &'static str,
            kind: &'static str,
            #[serde(rename = "runtimeAdapterId")]
            runtime_adapter_id: &'a str,
            #[serde(rename = "runtimeInstanceId")]
            runtime_instance_id: &'a str,
        }
        #[derive(Serialize)]
        struct Key<'a> {
            #[serde(rename = "type")]
            wire_type: &'static str,
            endpoint: Endpoint<'a>,
            #[serde(rename = "agentId")]
            agent_id: &'a str,
            #[serde(rename = "sessionKey")]
            session_key: &'a str,
        }
        canonical::encode(&Key {
            wire_type: "session-identity",
            endpoint: Endpoint {
                wire_type: "runtime-endpoint",
                kind: "native-runtime",
                runtime_adapter_id: self.endpoint.runtime_adapter_id(),
                runtime_instance_id: self.endpoint.runtime_instance_id(),
            },
            agent_id: &self.agent_id,
            session_key: &self.session_key,
        })
    }
}

/// Runtime-side scope for runtime, agent, session, and workspace addressing.
///
/// This scope constrains native runtime objects. It must not be mixed with
/// [`crate::capability::CapabilityScope`], which describes where a capability is
/// advertised or invoked.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum RuntimeScope {
    App,
    RuntimeInstance(RuntimeEndpoint),
    Agent {
        endpoint: RuntimeEndpoint,
        agent_id: String,
    },
    Session(SessionIdentity),
    Workspace {
        endpoint: RuntimeEndpoint,
        workspace_id: String,
        source_id: String,
    },
}

impl RuntimeScope {
    pub fn agent(
        endpoint: RuntimeEndpoint,
        agent_id: impl Into<String>,
    ) -> Result<Self, InvalidRuntimeAddress> {
        Ok(Self::Agent {
            endpoint,
            agent_id: identity(agent_id.into())?,
        })
    }

    pub fn workspace(
        endpoint: RuntimeEndpoint,
        workspace_id: impl Into<String>,
        source_id: impl Into<String>,
    ) -> Result<Self, InvalidRuntimeAddress> {
        Ok(Self::Workspace {
            endpoint,
            workspace_id: identity(workspace_id.into())?,
            source_id: identity(source_id.into())?,
        })
    }

    pub fn canonical_key(&self) -> String {
        #[derive(Serialize)]
        struct Endpoint<'a> {
            #[serde(rename = "type")]
            wire_type: &'static str,
            kind: &'static str,
            #[serde(rename = "runtimeAdapterId")]
            runtime_adapter_id: &'a str,
            #[serde(rename = "runtimeInstanceId")]
            runtime_instance_id: &'a str,
        }
        #[derive(Serialize)]
        struct Identity<'a> {
            #[serde(rename = "type")]
            wire_type: &'static str,
            endpoint: Endpoint<'a>,
            #[serde(rename = "agentId")]
            agent_id: &'a str,
            #[serde(rename = "sessionKey")]
            session_key: &'a str,
        }
        #[derive(Serialize)]
        struct Scope<'a> {
            #[serde(rename = "type")]
            wire_type: &'static str,
            kind: &'static str,
            #[serde(skip_serializing_if = "Option::is_none")]
            endpoint: Option<Endpoint<'a>>,
            #[serde(rename = "agentId", skip_serializing_if = "Option::is_none")]
            agent_id: Option<&'a str>,
            #[serde(skip_serializing_if = "Option::is_none")]
            identity: Option<Identity<'a>>,
            #[serde(rename = "workspaceId", skip_serializing_if = "Option::is_none")]
            workspace_id: Option<&'a str>,
            #[serde(rename = "sourceId", skip_serializing_if = "Option::is_none")]
            source_id: Option<&'a str>,
        }
        fn endpoint(endpoint: &RuntimeEndpoint) -> Endpoint<'_> {
            Endpoint {
                wire_type: "runtime-endpoint",
                kind: "native-runtime",
                runtime_adapter_id: endpoint.runtime_adapter_id(),
                runtime_instance_id: endpoint.runtime_instance_id(),
            }
        }
        let scope = match self {
            Self::App => Scope {
                wire_type: "runtime-scope",
                kind: "app",
                endpoint: None,
                agent_id: None,
                identity: None,
                workspace_id: None,
                source_id: None,
            },
            Self::RuntimeInstance(value) => Scope {
                wire_type: "runtime-scope",
                kind: "runtime-instance",
                endpoint: Some(endpoint(value)),
                agent_id: None,
                identity: None,
                workspace_id: None,
                source_id: None,
            },
            Self::Agent {
                endpoint: value,
                agent_id,
            } => Scope {
                wire_type: "runtime-scope",
                kind: "agent",
                endpoint: Some(endpoint(value)),
                agent_id: Some(agent_id),
                identity: None,
                workspace_id: None,
                source_id: None,
            },
            Self::Session(identity) => Scope {
                wire_type: "runtime-scope",
                kind: "session",
                endpoint: None,
                agent_id: None,
                identity: Some(Identity {
                    wire_type: "session-identity",
                    endpoint: endpoint(identity.endpoint()),
                    agent_id: identity.agent_id(),
                    session_key: &identity.session_key,
                }),
                workspace_id: None,
                source_id: None,
            },
            Self::Workspace {
                endpoint: value,
                workspace_id,
                source_id,
            } => Scope {
                wire_type: "runtime-scope",
                kind: "workspace",
                endpoint: Some(endpoint(value)),
                agent_id: None,
                identity: None,
                workspace_id: Some(workspace_id),
                source_id: Some(source_id),
            },
        };
        canonical::encode(&scope)
    }

    pub fn contains_session(&self, identity: &SessionIdentity) -> bool {
        match self {
            Self::Session(scope_identity) => scope_identity == identity,
            Self::Agent { endpoint, agent_id } => {
                endpoint == identity.endpoint() && agent_id == identity.agent_id()
            }
            Self::RuntimeInstance(endpoint) | Self::Workspace { endpoint, .. } => {
                endpoint == identity.endpoint()
            }
            Self::App => false,
        }
    }

    pub fn contains_workspace(
        &self,
        endpoint: &RuntimeEndpoint,
        workspace_id: &str,
        source_id: &str,
        identity: &SessionIdentity,
    ) -> bool {
        self.contains_session(identity)
            && matches!(
                self,
                Self::Workspace {
                    endpoint: scope_endpoint,
                    workspace_id: scope_workspace_id,
                    source_id: scope_source_id,
                } if scope_endpoint == endpoint
                    && scope_workspace_id == workspace_id
                    && scope_source_id == source_id
            )
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct InvalidRuntimeAddress;

impl fmt::Display for InvalidRuntimeAddress {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("runtime address identity is invalid")
    }
}

impl std::error::Error for InvalidRuntimeAddress {}

fn identity(value: String) -> Result<String, InvalidRuntimeAddress> {
    if value.trim().is_empty() || value.contains('\0') {
        return Err(InvalidRuntimeAddress);
    }
    Ok(value)
}
