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
    platform: RuntimeFamilyAvailability,
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
            platform: RuntimeFamilyAvailability::Supported,
        }
    }

    pub const fn matcha_agent() -> Self {
        Self {
            session: RuntimeFamilyAvailability::Supported,
            task: RuntimeFamilyAvailability::Unsupported,
            subagent: RuntimeFamilyAvailability::Unsupported,
            team: RuntimeFamilyAvailability::Supported,
            cron: RuntimeFamilyAvailability::Unsupported,
            workspace: RuntimeFamilyAvailability::Unsupported,
            skill: RuntimeFamilyAvailability::Unsupported,
            channel: RuntimeFamilyAvailability::Unsupported,
            lifecycle: RuntimeFamilyAvailability::Supported,
            platform: RuntimeFamilyAvailability::Unsupported,
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
            RuntimeCapabilityFamily::Platform => self.platform,
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
    Platform,
}

impl RuntimeCapabilityFamily {
    pub fn for_descriptor(descriptor_id: &str) -> Option<Self> {
        match descriptor_id {
            "session.prompt"
            | "session.management"
            | "session.approval"
            | "session.modelSelection"
            | "tool.invoke" => Some(Self::Session),
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
