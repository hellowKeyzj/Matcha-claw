use std::time::SystemTime;

use super::{ProcessIdentity, Provenance};

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ExitObservation {
    exit_code: Option<i32>,
    signal: Option<i32>,
    observed_at: SystemTime,
}

impl ExitObservation {
    pub(crate) fn new(
        exit_code: Option<i32>,
        signal: Option<i32>,
        observed_at: SystemTime,
    ) -> Self {
        Self {
            exit_code,
            signal,
            observed_at,
        }
    }

    pub const fn exit_code(&self) -> Option<i32> {
        self.exit_code
    }

    pub const fn signal(&self) -> Option<i32> {
        self.signal
    }

    pub const fn observed_at(&self) -> SystemTime {
        self.observed_at
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct ProcessObservation {
    identity: ProcessIdentity,
    provenance: Provenance,
}

impl ProcessObservation {
    pub(crate) const fn new(identity: ProcessIdentity, provenance: Provenance) -> Self {
        Self {
            identity,
            provenance,
        }
    }

    pub const fn identity(self) -> ProcessIdentity {
        self.identity
    }

    pub const fn provenance(self) -> Provenance {
        self.provenance
    }
}

#[cfg(test)]
mod tests {
    use std::time::{Duration, SystemTime};

    use super::*;

    #[test]
    fn exit_observation_preserves_exit_signal_and_timestamp_fields() {
        let observed_at = SystemTime::UNIX_EPOCH + Duration::from_secs(42);
        let observation = ExitObservation::new(Some(17), Some(9), observed_at);

        assert_eq!(observation.exit_code(), Some(17));
        assert_eq!(observation.signal(), Some(9));
        assert_eq!(observation.observed_at(), observed_at);
    }

    #[test]
    fn process_observation_preserves_identity_and_provenance_fields() {
        let identity = ProcessIdentity::new(42, 9);
        let provenance = Provenance::Attached { subject: identity };
        let observation = ProcessObservation::new(identity, provenance);

        assert_eq!(observation.identity(), identity);
        assert_eq!(observation.provenance(), provenance);
    }
}
