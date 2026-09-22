use platform::endpoint::runtime_address::RuntimeEndpoint;

const OPENCLAW_PROTOCOL_ID: &str = "openclaw-v4";
const OPENCLAW_RUNTIME_ADAPTER_ID: &str = "openclaw";
const MATCHA_PROTOCOL_ID: &str = "matcha-agent-app-server";
const MATCHA_RUNTIME_ADAPTER_ID: &str = "matcha-agent";
const LOCAL_RUNTIME_INSTANCE_ID: &str = "local";
const OPENCLAW_AGENT_ID: &str = "main";
const MATCHA_AGENT_ID: &str = "matcha";

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct RuntimeDriverIdentity {
    protocol_id: &'static str,
    runtime_adapter_id: &'static str,
    runtime_instance_id: &'static str,
    runtime_endpoint_reference: &'static str,
    default_agent_id: &'static str,
    display_name: &'static str,
}

impl RuntimeDriverIdentity {
    pub const fn open_claw() -> Self {
        Self {
            protocol_id: OPENCLAW_PROTOCOL_ID,
            runtime_adapter_id: OPENCLAW_RUNTIME_ADAPTER_ID,
            runtime_instance_id: LOCAL_RUNTIME_INSTANCE_ID,
            runtime_endpoint_reference: "endpoint:openclaw",
            default_agent_id: OPENCLAW_AGENT_ID,
            display_name: "OpenClaw",
        }
    }

    pub const fn matcha_agent() -> Self {
        Self {
            protocol_id: MATCHA_PROTOCOL_ID,
            runtime_adapter_id: MATCHA_RUNTIME_ADAPTER_ID,
            runtime_instance_id: LOCAL_RUNTIME_INSTANCE_ID,
            runtime_endpoint_reference: "endpoint:matcha",
            default_agent_id: MATCHA_AGENT_ID,
            display_name: "Matcha Agent",
        }
    }

    pub fn from_reference(reference: &str) -> Option<Self> {
        [Self::open_claw(), Self::matcha_agent()]
            .into_iter()
            .find(|identity| identity.runtime_endpoint_reference == reference)
    }

    pub fn endpoint(self) -> RuntimeEndpoint {
        RuntimeEndpoint::try_new(self.runtime_adapter_id, self.runtime_instance_id)
            .expect("fixed runtime endpoint identity is valid")
    }

    pub fn endpoint_id(self) -> String {
        format!("{}-{}", self.runtime_adapter_id, self.runtime_instance_id)
    }

    pub const fn protocol_id(self) -> &'static str {
        self.protocol_id
    }

    pub const fn runtime_adapter_id(self) -> &'static str {
        self.runtime_adapter_id
    }

    pub const fn runtime_instance_id(self) -> &'static str {
        self.runtime_instance_id
    }

    pub const fn runtime_endpoint_reference(self) -> &'static str {
        self.runtime_endpoint_reference
    }

    pub const fn default_agent_id(self) -> &'static str {
        self.default_agent_id
    }

    pub const fn display_name(self) -> &'static str {
        self.display_name
    }
}
