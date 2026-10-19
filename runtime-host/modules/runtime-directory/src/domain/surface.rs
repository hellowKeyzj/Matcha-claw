use serde_json::Value;

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct RuntimeCapabilitySurface {
    session: RuntimeFamilyAvailability,
    task: RuntimeFamilyAvailability,
    subagent: RuntimeFamilyAvailability,
    team: RuntimeFamilyAvailability,
    cron: RuntimeFamilyAvailability,
    workspace: RuntimeFamilyAvailability,
    skill: RuntimeFamilyAvailability,
    channel: RuntimeFamilyAvailability,
    lifecycle: RuntimeFamilyAvailability,
    usage: RuntimeFamilyAvailability,
    platform: RuntimeFamilyAvailability,
    board: RuntimeFamilyAvailability,
}

impl RuntimeCapabilitySurface {
    pub fn for_identity(identity: crate::RuntimeDriverIdentity) -> Self {
        if identity == crate::RuntimeDriverIdentity::open_claw() {
            Self::open_claw()
        } else {
            Self::matcha_agent()
        }
    }

    pub const fn open_claw() -> Self {
        Self {
            session: RuntimeFamilyAvailability::Supported,
            task: RuntimeFamilyAvailability::Supported,
            subagent: RuntimeFamilyAvailability::Supported,
            team: RuntimeFamilyAvailability::Supported,
            cron: RuntimeFamilyAvailability::Supported,
            workspace: RuntimeFamilyAvailability::Supported,
            skill: RuntimeFamilyAvailability::Supported,
            channel: RuntimeFamilyAvailability::Supported,
            lifecycle: RuntimeFamilyAvailability::Supported,
            usage: RuntimeFamilyAvailability::Supported,
            platform: RuntimeFamilyAvailability::Supported,
            board: RuntimeFamilyAvailability::Supported,
        }
    }

    pub const fn matcha_agent() -> Self {
        Self {
            session: RuntimeFamilyAvailability::Supported,
            task: RuntimeFamilyAvailability::Supported,
            subagent: RuntimeFamilyAvailability::Supported,
            team: RuntimeFamilyAvailability::Supported,
            cron: RuntimeFamilyAvailability::Supported,
            workspace: RuntimeFamilyAvailability::Supported,
            skill: RuntimeFamilyAvailability::Supported,
            channel: RuntimeFamilyAvailability::Supported,
            lifecycle: RuntimeFamilyAvailability::Supported,
            usage: RuntimeFamilyAvailability::Supported,
            platform: RuntimeFamilyAvailability::Unsupported,
            board: RuntimeFamilyAvailability::Unsupported,
        }
    }

    pub const fn availability(self, family: RuntimeCapabilityFamily) -> RuntimeFamilyAvailability {
        match family {
            RuntimeCapabilityFamily::Session => self.session,
            RuntimeCapabilityFamily::Task => self.task,
            RuntimeCapabilityFamily::Subagent => self.subagent,
            RuntimeCapabilityFamily::Team => self.team,
            RuntimeCapabilityFamily::Cron => self.cron,
            RuntimeCapabilityFamily::Workspace => self.workspace,
            RuntimeCapabilityFamily::Skill => self.skill,
            RuntimeCapabilityFamily::Channel => self.channel,
            RuntimeCapabilityFamily::Lifecycle => self.lifecycle,
            RuntimeCapabilityFamily::Usage => self.usage,
            RuntimeCapabilityFamily::Platform => self.platform,
            RuntimeCapabilityFamily::Board => self.board,
        }
    }

    pub const fn supports(self, family: RuntimeCapabilityFamily) -> bool {
        self.availability(family).is_supported()
    }

    pub fn availability_for_descriptor(
        self,
        descriptor_id: &str,
    ) -> Option<RuntimeFamilyAvailability> {
        RuntimeCapabilityFamily::for_descriptor(descriptor_id)
            .map(|family| self.availability(family))
    }

    pub fn supports_descriptor_for_scope(descriptor_id: &str, scope: &Value) -> bool {
        let Some(identity) = runtime_identity_for_scope(scope) else {
            return true;
        };
        Self::for_identity(identity)
            .availability_for_descriptor(descriptor_id)
            .is_none_or(|availability| availability.is_supported())
    }
}

fn runtime_identity_for_scope(scope: &Value) -> Option<crate::RuntimeDriverIdentity> {
    match scope.get("kind").and_then(Value::as_str)? {
        "runtime-instance" | "agent" | "workspace" | "team-run" => {
            runtime_identity_for_endpoint(scope.get("endpoint")?)
        }
        "session" => runtime_identity_for_endpoint(scope.get("identity")?.get("endpoint")?),
        _ => None,
    }
}

fn runtime_identity_for_endpoint(endpoint: &Value) -> Option<crate::RuntimeDriverIdentity> {
    let object = endpoint.as_object()?;
    if object.get("kind").and_then(Value::as_str)? != "native-runtime" {
        return None;
    }
    let adapter = object.get("runtimeAdapterId").and_then(Value::as_str)?;
    let instance = object.get("runtimeInstanceId").and_then(Value::as_str)?;
    for identity in [
        crate::RuntimeDriverIdentity::open_claw(),
        crate::RuntimeDriverIdentity::matcha_agent(),
    ] {
        if adapter == identity.runtime_adapter_id() && instance == identity.runtime_instance_id() {
            return Some(identity);
        }
    }
    None
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum RuntimeCapabilityFamily {
    Session,
    Task,
    Subagent,
    Team,
    Cron,
    Workspace,
    Skill,
    Channel,
    Lifecycle,
    Usage,
    Platform,
    Board,
}

impl RuntimeCapabilityFamily {
    pub fn for_descriptor(descriptor_id: &str) -> Option<Self> {
        match descriptor_id {
            "session.prompt"
            | "session.management"
            | "session.approval"
            | "session.question"
            | "session.modelSelection"
            | "session.goal"
            | "tool.invoke" => Some(Self::Session),
            "board.runtime" => Some(Self::Board),
            "task.management" => Some(Self::Task),
            "subagent.management" | "subagent.skills" | "subagent.tools" => Some(Self::Subagent),
            "team.runtime" => Some(Self::Team),
            "scheduler.cron" => Some(Self::Cron),
            "workspace.file" | "workspace.media" => Some(Self::Workspace),
            "skill.management" => Some(Self::Skill),
            "integration.channel" => Some(Self::Channel),
            "runtime.platform"
            | "runtime.paths"
            | "runtime.cli"
            | "runtime.toolPermission"
            | "runtime.subagentTemplates" => Some(Self::Platform),
            _ => None,
        }
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum RuntimeFamilyAvailability {
    Supported,
    Unsupported,
}

impl RuntimeFamilyAvailability {
    pub const fn is_supported(self) -> bool {
        matches!(self, Self::Supported)
    }

    pub const fn availability_label(self, ready: bool) -> &'static str {
        match (self, ready) {
            (Self::Supported, true) => "available",
            (Self::Supported, false) => "unavailable",
            (Self::Unsupported, _) => "unsupported",
        }
    }
}
