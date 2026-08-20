use super::observed::ObservedFleet;

#[derive(Clone, Copy, Debug, Eq, Ord, PartialEq, PartialOrd)]
pub struct DesiredFleetRevision(u64);

impl DesiredFleetRevision {
    pub const fn new(value: u64) -> Self {
        Self(value)
    }

    pub const fn get(self) -> u64 {
        self.0
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct FleetDesired {
    revision: DesiredFleetRevision,
}

impl FleetDesired {
    pub const fn new(revision: DesiredFleetRevision) -> Self {
        Self { revision }
    }

    pub const fn revision(self) -> DesiredFleetRevision {
        self.revision
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct FleetApplied {
    revision: DesiredFleetRevision,
}

impl FleetApplied {
    pub const fn new(revision: DesiredFleetRevision) -> Self {
        Self { revision }
    }

    pub const fn revision(self) -> DesiredFleetRevision {
        self.revision
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct CapabilityStaleAfter(u64);

impl CapabilityStaleAfter {
    pub const fn from_seconds(seconds: u64) -> Self {
        Self(seconds)
    }

    pub const fn seconds(self) -> u64 {
        self.0
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct FleetReconcilePolicy {
    capability_stale_after: CapabilityStaleAfter,
}

impl FleetReconcilePolicy {
    pub const fn new(capability_stale_after: CapabilityStaleAfter) -> Self {
        Self {
            capability_stale_after,
        }
    }

    pub const fn capability_stale_after(self) -> CapabilityStaleAfter {
        self.capability_stale_after
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct FleetReconcileInput<'a> {
    desired: &'a FleetDesired,
    applied: Option<&'a FleetApplied>,
    observed: &'a ObservedFleet,
    now: u64,
}

impl<'a> FleetReconcileInput<'a> {
    pub const fn new(
        desired: &'a FleetDesired,
        applied: Option<&'a FleetApplied>,
        observed: &'a ObservedFleet,
        now: u64,
    ) -> Self {
        Self {
            desired,
            applied,
            observed,
            now,
        }
    }

    pub const fn desired(self) -> &'a FleetDesired {
        self.desired
    }

    pub const fn applied(self) -> Option<&'a FleetApplied> {
        self.applied
    }

    pub const fn observed(self) -> &'a ObservedFleet {
        self.observed
    }

    pub const fn now(self) -> u64 {
        self.now
    }
}
