use crate::{
    EnvironmentId, EnvironmentObservationPort, EnvironmentProjectionPort, EnvironmentRevision,
};

use super::AppliedProjection;

#[test]
fn ports_are_distinct_object_safe_consumer_capabilities() {
    let projection_port: Option<&dyn EnvironmentProjectionPort> = None;
    let observation_port: Option<&dyn EnvironmentObservationPort> = None;

    assert!(projection_port.is_none());
    assert!(observation_port.is_none());
}

#[test]
fn applied_projection_is_revision_evidence_not_observation() {
    let projection = AppliedProjection::new(
        EnvironmentId::try_new("environment:primary").unwrap(),
        EnvironmentRevision::try_new(7).unwrap(),
    );

    assert_eq!(projection.environment_id().as_str(), "environment:primary");
    assert_eq!(projection.revision().get(), 7);
}
