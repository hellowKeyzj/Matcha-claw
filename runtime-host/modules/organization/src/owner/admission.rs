#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum OrganizationPhase {
    ShutDown,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct RequestAdmissionClosed {
    phase: OrganizationPhase,
}

impl RequestAdmissionClosed {
    pub const fn new(phase: OrganizationPhase) -> Self {
        Self { phase }
    }

    pub const fn phase(self) -> OrganizationPhase {
        self.phase
    }
}
