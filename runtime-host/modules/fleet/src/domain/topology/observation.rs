use std::time::SystemTime;

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum ObservationSource {
    Discovery,
    HealthProbe,
    RuntimeAgent,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum ObservationFreshness {
    Current,
    Stale,
    Unknown,
    Pruned,
}

impl ObservationFreshness {
    pub const fn is_current(self) -> bool {
        matches!(self, Self::Current)
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct ObservationMetadata {
    source: ObservationSource,
    observed_at: SystemTime,
    freshness: ObservationFreshness,
}

impl ObservationMetadata {
    pub const fn new(
        source: ObservationSource,
        observed_at: SystemTime,
        freshness: ObservationFreshness,
    ) -> Self {
        Self {
            source,
            observed_at,
            freshness,
        }
    }

    pub const fn source(self) -> ObservationSource {
        self.source
    }

    pub const fn observed_at(self) -> SystemTime {
        self.observed_at
    }

    pub const fn freshness(self) -> ObservationFreshness {
        self.freshness
    }
}
