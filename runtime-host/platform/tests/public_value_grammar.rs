use platform::{
    capability::{CapabilityAvailability, CapabilityId, CapabilityScope, SupportedCapability},
    endpoint::EndpointId,
    exchange::InvocationOutcome,
};

#[test]
fn exposes_only_consumer_owned_platform_grammar() {
    let endpoint = EndpointId::try_new("runtime:primary").unwrap();
    let capability = SupportedCapability::new(
        CapabilityId::try_new("session.prompt").unwrap(),
        CapabilityScope::Session,
    );
    let outcome: InvocationOutcome<(), ()> = InvocationOutcome::Unknown;

    assert_eq!(endpoint.as_str(), "runtime:primary");
    assert_eq!(capability.scope(), CapabilityScope::Session);
    assert!(matches!(
        CapabilityAvailability::Available,
        CapabilityAvailability::Available
    ));
    assert!(matches!(outcome, InvocationOutcome::Unknown));
}
